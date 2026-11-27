// Package telemetry is the tray's edge producer for the Faravan telemetry inbox (docs/design/TELEMETRY.md §2.2, §3.4).
//
// The tray writes two records: a panic, which the tray re-raises after writing it, and the app going unanswered for a
// long time. It never decides consent. It reads <home>/v1/telemetry/policy.json, writes nothing when telemetry is off,
// switched off by the environment, or the policy cannot be read, and otherwise copies the generation it read into the
// file it writes. The app decides what each file may feed (docs/design/TELEMETRY-WIRE.md §9).
package telemetry

import (
	"bytes"
	"crypto/rand"
	"encoding/json"
	"errors"
	"io/fs"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// SchemaVersion is the catalog version these records are valid at: every entry and enum member they use is live at
// version 1, and the golden fixtures pin it (docs/design/TELEMETRY-WIRE.md §8, §10). The app validates at this version.
const SchemaVersion = 1

const (
	inboxFormat      = "faravan-telemetry-inbox"
	origin           = "tray"
	maxInboxFiles    = 200
	maxInboxBytes    = 16 * 1024
	crashLoopWindow  = 5 * time.Minute
	unreachableAfter = 10 * time.Minute
	crashLastFile    = "crash-last" // shared with the app's crash marker, so a loop across both counts once
	base32Alphabet   = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567"
)

var (
	errNothingToWrite = errors.New("telemetry: nothing to write")
	errCorruptPolicy  = errors.New("telemetry: policy.json is not a valid policy")
	offValues         = map[string]bool{"": true, "0": true, "false": true}
	levelNames        = map[string]bool{"off": true, "counts": true, "diagnostics": true}
	regionPattern     = regexp.MustCompile(`^[A-Z]{2}$`)
)

// Writer writes inbox files under Dir, the telemetry directory of the app home (<home>/v1/telemetry). An empty Dir
// writes nothing. Env reads the process environment for the off switches and Now is the clock; nil means the real ones.
type Writer struct {
	Dir string
	Env func(string) (string, bool)
	Now func() time.Time
}

// inboxFile is the envelope of one inbox file. Fields are in JSON key order, so encoding gives the canonical form.
type inboxFile struct {
	Format        string `json:"format"`
	Gen           int64  `json:"gen"`
	Origin        string `json:"origin"`
	Record        any    `json:"record"`
	SchemaVersion int    `json:"schema_version"`
}

// crashRecord is an app.crash event. Fields are in JSON key order.
type crashRecord struct {
	Attrs crashAttrs `json:"attrs"`
	Hour  string     `json:"hour"`
	Kind  string     `json:"kind"`
	Name  string     `json:"name"`
}

type crashAttrs struct {
	CrashKind    string  `json:"crash.kind"`
	CrashLoop    bool    `json:"crash_loop"`
	Errno        string  `json:"errno"`
	Frames       []frame `json:"frames"`
	JSErrorClass string  `json:"js.error_class"`
	Uptime       string  `json:"uptime"`
}

// frame is a {file, line} crash frame. A tray panic has none: the stack text is never sent.
type frame struct {
	File string `json:"file"`
	Line int    `json:"line"`
}

// healthRecord is a health.state counts record. Fields are in JSON key order.
type healthRecord struct {
	Attrs  healthAttrs `json:"attrs"`
	Name   string      `json:"name"`
	Period string      `json:"period"`
	Value  int         `json:"value"`
}

type healthAttrs struct {
	Check  string `json:"check"`
	Reason string `json:"reason,omitempty"`
	State  string `json:"state"`
}

// durationBounds are the duration_s bucket bounds in seconds (docs/design/TELEMETRY-WIRE.md §5).
var durationBounds = []float64{1, 5, 15, 60, 300, 900, 1800, 3600, 7200, 21600, 86400}

// Panic records a tray panic. The caller re-raises the panic afterwards, so the crash itself is unchanged. crash_loop
// is true when the last crash, from the tray or the app, was less than five minutes ago. It returns why nothing was
// written, if it wrote nothing; the caller is already dying and ignores it.
func (w Writer) Panic(uptime time.Duration) error {
	gen, err := w.generation()
	if err != nil {
		return err
	}
	if err := w.roomForOne(); err != nil {
		return err
	}
	now := w.now()
	loop := w.crashLoop(now)
	if err := os.WriteFile(filepath.Join(w.Dir, crashLastFile), []byte(strconv.FormatInt(now.UnixMilli(), 10)), 0o600); err != nil {
		return err
	}
	return w.write(gen, crashRecord{
		Attrs: crashAttrs{CrashKind: "panic", CrashLoop: loop, Errno: "none", Frames: []frame{}, JSErrorClass: "other",
			Uptime: durationBucket(uptime.Seconds())},
		Hour: hourOf(now),
		Kind: "event",
		Name: "app.crash",
	})
}

// AppUnreachable records that the app has not answered the tray (health.state app_reachable, state blocked). The caller
// decides when; see Unreachable.
func (w Writer) AppUnreachable(now time.Time) error {
	gen, err := w.generation()
	if err != nil {
		return err
	}
	return w.write(gen, healthRecord{
		Attrs:  healthAttrs{Check: "app_reachable", State: "blocked"},
		Name:   "health.state",
		Period: hourOf(now),
		Value:  1,
	})
}

// generation is the generation a file written now must carry, or errNothingToWrite. It mirrors the app's edge rule
// (lib/v1/telemetry/consent.mjs edgeGeneration): an environment switch, a level of off or an unreadable policy write
// nothing, and a missing policy writes generation 0.
func (w Writer) generation() (int64, error) {
	if w.Dir == "" {
		return 0, errNothingToWrite // never read or write a relative path
	}
	// The product variable is read first; the legacy one only while the product variable is unset (switch.mjs envSwitch).
	product := "FARAVAN_NO_TELEMETRY"
	if _, set := w.env(product); !set {
		product = "FARAVAN_NO_TELEMETRY"
	}
	for _, name := range []string{product, "DO_NOT_TRACK"} {
		if value, set := w.env(name); set && !offValues[strings.ToLower(strings.TrimSpace(value))] {
			return 0, errNothingToWrite
		}
	}
	raw, err := os.ReadFile(filepath.Join(w.Dir, "policy.json"))
	if errors.Is(err, fs.ErrNotExist) {
		return 0, nil
	}
	if err != nil {
		return 0, errNothingToWrite
	}
	gen, level, err := parsePolicy(raw)
	if err != nil || level == "off" {
		return 0, errNothingToWrite
	}
	return gen, nil
}

// parsePolicy checks policy.json the way the app does (validPolicy in consent.mjs): every key is present and typed.
// Generation and region are the only fields a producer reads; a missing key makes the policy corrupt.
func parsePolicy(raw []byte) (int64, string, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return 0, "", errCorruptPolicy
	}
	if version, ok := number(fields["version"]); !ok || version != 1 {
		return 0, "", errCorruptPolicy
	}
	level, err := nullableLevel(fields["level"])
	if err != nil {
		return 0, "", err
	}
	if !present(fields["region"]) || !(isNull(fields["region"]) || regionMatches(fields["region"])) {
		return 0, "", errCorruptPolicy
	}
	generation, ok := number(fields["generation"])
	if !ok || generation != math.Trunc(generation) || generation < 0 || generation > 1<<53-1 {
		return 0, "", errCorruptPolicy
	}
	for _, key := range []string{"noticeShownAt", "decidedAt"} {
		if !present(fields[key]) || (!isNull(fields[key]) && !isNumber(fields[key])) {
			return 0, "", errCorruptPolicy
		}
	}
	return int64(generation), level, nil
}

// nullableLevel returns the level ("" for null) or an error for a missing or unknown level.
func nullableLevel(raw json.RawMessage) (string, error) {
	if !present(raw) {
		return "", errCorruptPolicy
	}
	if isNull(raw) {
		return "", nil
	}
	var level string
	if json.Unmarshal(raw, &level) != nil || !levelNames[level] {
		return "", errCorruptPolicy
	}
	return level, nil
}

func number(raw json.RawMessage) (float64, bool) {
	var value float64
	return value, json.Unmarshal(raw, &value) == nil && isNumber(raw)
}

func isNumber(raw json.RawMessage) bool {
	trimmed := bytes.TrimSpace(raw)
	return len(trimmed) > 0 && (trimmed[0] == '-' || (trimmed[0] >= '0' && trimmed[0] <= '9'))
}

func regionMatches(raw json.RawMessage) bool {
	var region string
	return json.Unmarshal(raw, &region) == nil && regionPattern.MatchString(region)
}

func present(raw json.RawMessage) bool { return len(bytes.TrimSpace(raw)) > 0 }

func isNull(raw json.RawMessage) bool { return bytes.Equal(bytes.TrimSpace(raw), []byte("null")) }

// write puts one record in the inbox. The file is written under a temporary name, synced and renamed, so a reader never
// sees part of it. A full inbox takes nothing.
func (w Writer) write(gen int64, record any) error {
	if err := w.roomForOne(); err != nil {
		return err
	}
	body, err := encode(inboxFile{Format: inboxFormat, Gen: gen, Origin: origin, Record: record, SchemaVersion: SchemaVersion})
	if err != nil {
		return err
	}
	if len(body) > maxInboxBytes {
		return errNothingToWrite
	}
	name, err := randomName()
	if err != nil {
		return err
	}
	target := filepath.Join(w.Dir, "inbox", name+".json")
	temp := target + ".tmp"
	file, err := os.OpenFile(temp, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	_, err = file.Write(body)
	if err == nil {
		err = file.Sync()
	}
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(temp, target)
	}
	if err != nil {
		_ = os.Remove(temp)
	}
	return err
}

// roomForOne fails when the inbox already holds its 200 files. Like the app's counter, it counts every entry.
func (w Writer) roomForOne() error {
	if w.Dir == "" {
		return errNothingToWrite
	}
	inbox := filepath.Join(w.Dir, "inbox")
	if err := os.MkdirAll(inbox, 0o700); err != nil {
		return err
	}
	entries, err := os.ReadDir(inbox)
	if err != nil {
		return err
	}
	if len(entries) >= maxInboxFiles {
		return errNothingToWrite
	}
	return nil
}

// crashLoop reports whether the last crash was less than the loop window ago. An unreadable marker is no loop.
func (w Writer) crashLoop(now time.Time) bool {
	raw, err := os.ReadFile(filepath.Join(w.Dir, crashLastFile))
	if err != nil {
		return false
	}
	last, err := strconv.ParseFloat(strings.TrimSpace(string(raw)), 64)
	if err != nil {
		return false
	}
	return float64(now.UnixMilli())-last < float64(crashLoopWindow.Milliseconds())
}

func (w Writer) env(name string) (string, bool) {
	if w.Env == nil {
		return os.LookupEnv(name)
	}
	return w.Env(name)
}

func (w Writer) now() time.Time {
	if w.Now == nil {
		return time.Now()
	}
	return w.Now()
}

// encode is the canonical form (docs/design/TELEMETRY-WIRE.md §11): sorted keys, no spaces, and the one newline the
// golden files end with. HTML escaping is off so the bytes match the Node encoder.
func encode(file inboxFile) ([]byte, error) {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(file); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

// randomName is "c-" and 20 base32 characters, the same shape as the app's random IDs.
func randomName() (string, error) {
	raw := make([]byte, 20)
	if _, err := rand.Read(raw); err != nil {
		return "", err
	}
	name := []byte("c-")
	for _, b := range raw {
		name = append(name, base32Alphabet[b&31])
	}
	return string(name), nil
}

// durationBucket is the smallest bound at or above seconds, as its label; "inf" above the last bound.
func durationBucket(seconds float64) string {
	for _, bound := range durationBounds {
		if seconds <= bound {
			return strconv.FormatInt(int64(bound), 10)
		}
	}
	return "inf"
}

// hourOf is the UTC hour, the only time finer than a day that leaves a machine (docs/design/TELEMETRY-WIRE.md §4).
func hourOf(now time.Time) string { return now.UTC().Format("2006-01-02T15") }
