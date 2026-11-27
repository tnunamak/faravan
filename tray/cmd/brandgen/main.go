// Command brandgen draws every file derived from Faravan's mark (#mark in ui/v1/src/icons.svg): the
// tray-* symbols, the favicons, the web app and Linux icons, and the macOS app icon. Run it from the
// tray module after an edit to #mark:
//
//	cd tray && go run ./cmd/brandgen
//
// It writes into the repository one level up; -root names another checkout.
package main

import (
	"flag"
	"fmt"
	"os"

	"github.com/tnunamak/faravan/tray/internal/brandmark"
)

func main() {
	root := flag.String("root", "..", "the repository root")
	flag.Parse()
	files, err := brandmark.Generate(*root)
	if err == nil {
		err = brandmark.Write(*root, files)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "brandgen:", err)
		os.Exit(1)
	}
	for _, f := range files {
		fmt.Println("wrote", f.Path)
	}
}
