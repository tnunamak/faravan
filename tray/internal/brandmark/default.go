package brandmark

import "sync"

var parsed = sync.OnceValue(func() Mark {
	m, err := ParseMark(MarkSymbol)
	if err != nil {
		panic(err) // MarkSymbol is generated from a mark that parsed; TestGeneratedFilesMatchTheMark keeps it so
	}
	return m
})

// Default is the mark compiled into the tray (MarkSymbol).
func Default() Mark { return parsed() }
