package faravantray

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// Owner rule (11-05): the tray shows the Faravan icon alone. No label or title text beside it on any OS;
// hover text is the tooltip, which stays. A regression here fails in a test instead of in someone's menu bar.
// The systray calls cannot run in a test, so this scans the tray's own non-test Go sources for label setters.
var visibleLabelSetter = regexp.MustCompile(`\.Set(Title|Label)\(`)

func TestTraySetsNoVisibleLabel(t *testing.T) {
	var files []string
	for _, dir := range []string{filepath.Join("..", "..", "cmd", "faravan-tray"), "."} {
		matches, err := filepath.Glob(filepath.Join(dir, "*.go"))
		if err != nil { t.Fatal(err) }
		files = append(files, matches...)
	}
	scanned := 0
	for _, file := range files {
		if strings.HasSuffix(file, "_test.go") { continue }
		src, err := os.ReadFile(file)
		if err != nil { t.Fatal(err) }
		scanned++
		for _, line := range strings.Split(string(src), "\n") {
			if visibleLabelSetter.MatchString(line) { t.Errorf("%s sets a visible tray label: %s", file, strings.TrimSpace(line)) }
		}
	}
	if scanned == 0 { t.Fatal("found no tray sources to scan") }
}
