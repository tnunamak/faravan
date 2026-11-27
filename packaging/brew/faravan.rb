class Faravan < Formula
  desc "Local Faravan v1 app, web UI, and native tray helper"
  homepage "https://github.com/tnunamak/faravan"
  url "https://github.com/tnunamak/faravan/archive/refs/tags/v0.0.0.tar.gz"
  sha256 "REPLACE_WITH_RELEASE_TARBALL_SHA256"
  license "MIT"

  depends_on "go" => :build
  depends_on "node"

  def install
    libexec.install "bin", "lib", "public", "kits"
    libexec.install "package.json", "package-lock.json"
    libexec.install "vendor" if File.directory?("vendor")
    system Formula["node"].opt_bin/"npm", "ci", "--prefix", libexec,
      "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"
    (libexec/"docs/protocol").install Dir["docs/protocol/*.schema.json"]
    (libexec/"profiles").install "profiles/faravan-docker.json"
    (lib/"systemd/user").install "packaging/assets/faravan-app.service"
    inreplace lib/"systemd/user/faravan-app.service", "/usr/bin/faravan", (opt_bin/"faravan").to_s
    cd "tray" do
      system "go", "build", "-trimpath", "-o", libexec/"faravan-tray", "./cmd/faravan-tray"
      if OS.mac?
        system "go", "build", "-trimpath", "-o", libexec/"bin/faravan-process-identity", "./cmd/faravan-process-identity"
      end
    end

    (bin/"faravan").write <<~EOS
      #!/bin/sh
      export PATH="#{libexec}:$PATH"
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/faravan" "$@"
    EOS

    (bin/"faravan").write <<~EOS
      #!/bin/sh
      export PATH="#{libexec}:$PATH"
      exec "#{Formula["node"].opt_bin}/node" "#{libexec}/bin/faravan" "$@"
    EOS

  end

  test do
    help = shell_output("#{bin}/faravan --help")
    assert_match(/usage: faravan/i, help)
    %w[app circle job mcp host].each { |verb| assert_match(/^  #{verb}(\s|$)/, help) }
    %w[index.html app.mjs app.css].each { |asset| assert_predicate libexec/"public/v1"/asset, :file? }
    assert_predicate libexec/"faravan-tray", :executable?
    assert_predicate libexec/"profiles/faravan-docker.json", :file?
    cd libexec do
      system Formula["node"].opt_bin/"node", "--input-type=module", "--eval", <<~'JS'
        import assert from "node:assert/strict";
        import { readFileSync, realpathSync } from "node:fs";
        import { join, relative, isAbsolute, sep } from "node:path";
        import { fileURLToPath, pathToFileURL } from "node:url";

        const inside = (parent, candidate, label) => {
          const actual = realpathSync(candidate), path = relative(parent, actual);
          assert.ok(path !== "" && path !== ".." && !path.startsWith(".." + sep) && !isAbsolute(path),
            label + " must remain inside " + parent);
          return actual;
        };
        const root = realpathSync(process.cwd());
        const manifestPath = inside(root, join(root, "package.json"), "production manifest");
        const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
        const pin = manifest.dependencies?.["@tnunamak/gozar"];
        const expected = typeof pin === "string" && (/^file:vendor\/tnunamak-gozar-(\d+\.\d+\.\d+)\.tgz$/.exec(pin)?.[1] ?? pin);
        assert.equal(typeof expected, "string", "Gozar must be exactly pinned");
        assert.match(expected, /^[0-9]+[.][0-9]+[.][0-9]+$/, "Gozar must be exactly pinned");
        const sdk = inside(root, join(root, "node_modules/@tnunamak/gozar"), "SDK directory");
        const metadata = inside(sdk, join(sdk, "package.json"), "SDK metadata");
        const installed = JSON.parse(readFileSync(metadata, "utf8"));
        assert.equal(installed.name, "@tnunamak/gozar", "installed Gozar package name");
        assert.equal(installed.version, expected, "installed Gozar must match the production pin");
        // Resolve using import conditions, but do not evaluate until containment passes.
        const entry = inside(sdk, fileURLToPath(import.meta.resolve("@tnunamak/gozar")), "SDK import entry");
        const { createGozar } = await import(pathToFileURL(entry).href);
        assert.equal(typeof createGozar, "function", "Gozar factory export must be callable");
      JS
    end
  end

  service do
    run [Formula["node"].opt_bin/"node", opt_libexec/"lib/v1/resident.mjs", "--background", "--tray", opt_libexec/"faravan-tray"]
    environment_variables FARAVAN_NO_BROWSER: "1"
    keep_alive successful_exit: false
    restart_delay 3
    log_path var/"log/faravan.log"
    error_log_path var/"log/faravan.log"
  end

  def caveats
    <<~EOS
      Start the local Faravan v1 app (as your normal user):
        brew services start faravan

      Open the local web app:
        faravan
    EOS
  end
end
