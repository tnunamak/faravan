package faravantray

import (
	"encoding/json"
	"os"
	"testing"
)

// The Node parity test runs this probe in a separate process for each fixture.
func TestHomePathParityProbe(t *testing.T) {
	output := os.Getenv("FARAVAN_HOME_PARITY_OUTPUT")
	if output == "" {
		return
	}
	home, err := HomePath()
	result := struct {
		Home  string `json:"home"`
		Error bool   `json:"error"`
	}{Home: home, Error: err != nil}
	data, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(output, data, 0o600); err != nil {
		t.Fatal(err)
	}
}
