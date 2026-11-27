package faravantray

import (
	"context"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"
	"time"
)

const gptID = "0b8f6f0e-5d0b-4f3e-9d63-2f6f1f0a1c11"
const gptJSON = `[{"id":"` + gptID + `","label":"Turn lending on","what":"Lending turns on for the Weekend circle. SECRET-PEER-PROMPT","expiresAt":1790000000000}]`

func gptClient(t *testing.T, seen *[]string, pending string, actions func() *http.Response) LocalClient {
	t.Helper()
	c := LocalClient{AppPath: t.TempDir() + "/v1/app.json", Alive: func(int) bool { return true }}
	writeRecord(t, c.AppPath, appRecord(1234))
	c.AppClient.HTTPClient = &http.Client{Transport: roundTripFunc(func(r *http.Request) (*http.Response, error) {
		*seen = append(*seen, r.Method+" "+r.URL.Path)
		switch r.URL.Path {
		case "/api/approvals":
			return reply(200, `[{"id":"job1","localName":"Sam","job":{"circle":"c1"}}]`), nil
		case "/api/chatgpt/actions":
			return actions(), nil
		}
		return reply(200, `{"state":"ready","chatgpt_pending":`+pending+`}`), nil
	})}
	return c
}

func TestStatusCarriesChatgptPending(t *testing.T) {
	client := AppClient{HTTPClient: appHTTP(t, func(*http.Request) string { return `{"state":"ready","chatgpt_pending":3}` })}
	status, err := client.Status(context.Background(), AppInfo{Port: 1, Token: "t"})
	if err != nil || status.ChatgptPending != 3 { t.Fatalf("%d %v", status.ChatgptPending, err) }
}

func TestChatgptApprovalsPrefixIDsAndKeepOnlyStaticFields(t *testing.T) {
	var path string
	client := AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string { path = r.Method + " " + r.URL.Path; return gptJSON })}
	cards, err := client.ChatgptApprovals(context.Background(), AppInfo{Port: 1, Token: "t"})
	if err != nil || path != "GET /api/chatgpt/actions" || len(cards) != 1 { t.Fatalf("%v %q %v", cards, path, err) }
	c := cards[0]
	if c.ID != "chatgpt:"+gptID || c.Kind != "chatgpt" || c.Label != "Turn lending on" || c.ExpiresAt != 1790000000000 || !strings.HasPrefix(c.What, "Lending turns on") { t.Fatalf("%#v", c) }
}

func TestDiscoverReadsChatgptActionsOnlyWhenPending(t *testing.T) {
	var seen []string
	c := gptClient(t, &seen, "0", func() *http.Response { t.Error("read with nothing pending"); return reply(200, `[]`) })
	conn := c.Discover(context.Background())
	if !conn.CardsKnown || len(conn.Cards) != 1 { t.Fatalf("%v", conn.Cards) }
	for _, s := range seen { if strings.Contains(s, "chatgpt") { t.Fatal(s) } }

	seen = nil
	c = gptClient(t, &seen, "1", func() *http.Response { return reply(200, gptJSON) })
	conn = c.Discover(context.Background())
	if !conn.CardsKnown || len(conn.Cards) != 2 || conn.Cards[0].ID != "job1" || conn.Cards[1].ID != "chatgpt:"+gptID { t.Fatalf("%#v", conn.Cards) }
	if !hasEntry(conn.Menu, "review:job1") || !hasEntry(conn.Menu, "review:chatgpt:"+gptID) { t.Fatal("both cards need review lines") }
	if !reflect.DeepEqual(seen[len(seen)-3:], []string{"GET /api/home", "GET /api/approvals", "GET /api/chatgpt/actions"}) { t.Fatal(seen) }
}

func TestFailedChatgptReadIsUnknownNotEmpty(t *testing.T) {
	var seen []string
	c := gptClient(t, &seen, "1", func() *http.Response { return reply(500, `{}`) })
	conn := c.Discover(context.Background())
	if conn.CardsKnown { t.Fatal("a failed ChatGPT read must not look like an empty list") }
	if !hasEntry(conn.Menu, "review:job1") { t.Fatal("job cards still show") }
	var tr RequestTracker
	tr.Update([]ApprovalCard{{ID: "job1"}, {ID: "chatgpt:" + gptID}}, true)
	if fresh, gone := tr.Update(conn.Cards, conn.CardsKnown); len(fresh) != 0 || len(gone) != 0 { t.Fatalf("no false gone: %v %v", fresh, gone) }
}

func TestChatgptNotificationIsGenericAndPeerFree(t *testing.T) {
	card := ApprovalCard{ID: "chatgpt:" + gptID, Kind: "chatgpt", Label: "Turn lending on", What: "SECRET-PEER-PROMPT"}
	n := NotificationForCard(card, nil)
	if n.ID != card.ID || n.Title != "Allow ChatGPT to Turn lending on" || n.Body != "Review the exact effect in Faravan on this computer." { t.Fatalf("%#v", n) }
	if strings.Contains(n.Title+n.Body, "SECRET") { t.Fatal("effect text reached the OS") }
	if n := NotificationForCard(ApprovalCard{ID: "chatgpt:x", Kind: "chatgpt"}, nil); n.Title != "ChatGPT needs your approval" { t.Fatal(n.Title) }
}

func TestMenuNamesChatgptRequests(t *testing.T) {
	menu := BuildMenu(MenuInput{Status: AppStatus{State: "ready"}, Cards: []ApprovalCard{{ID: "chatgpt:" + gptID, Kind: "chatgpt", Label: "Turn lending on"}}, Now: time.Now(), GOOS: "linux"})
	found := false
	for _, e := range menu.Entries { if e.ID == "review:chatgpt:"+gptID { found = e.Label == "Review ChatGPT request…" } }
	if !found { t.Fatal(menu.Labels()) }
	if menu.State != VisualAttention { t.Fatal("a pending ChatGPT request needs attention") }
}

func TestChatgptReviewOpensActionWithoutFragmentAndDeclineHasNoBody(t *testing.T) {
	var calls []string
	client := AppClient{HTTPClient: appHTTP(t, func(r *http.Request) string {
		calls = append(calls, r.Method+" "+r.URL.Path)
		return `{"url":"http://127.0.0.1:4000/auth/handoff?code=once"}`
	})}
	info := AppInfo{Port: 4000, Token: "t"}
	var opened []string
	open := func(u string) error { opened = append(opened, u); return nil }
	id := "chatgpt:" + gptID
	if err := HandleAction(context.Background(), client, info, id, ActionReview, open); err != nil { t.Fatal(err) }
	want := "http://127.0.0.1:4000/auth/handoff?code=once&chatgpt_action=" + url.QueryEscape(gptID)
	if !reflect.DeepEqual(opened, []string{want}) { t.Fatal(opened) }
	if err := HandleAction(context.Background(), client, info, id, ActionDecline, open); err != nil { t.Fatal(err) }
	if !reflect.DeepEqual(calls, []string{"POST /api/handoff", "POST /api/chatgpt/actions/" + gptID + "/decline"}) { t.Fatal(calls) }
	for _, c := range calls { if strings.Contains(c, "accept") || strings.Contains(c, "/api/approvals") { t.Fatal(c) } }
}

func TestChatgptMenuReviewReusesHandleAction(t *testing.T) {
	client := AppClient{HTTPClient: appHTTP(t, func(*http.Request) string { return `{"url":"http://127.0.0.1:4000/auth/handoff?code=once"}` })}
	var opened []string
	env := ActionEnv{Client: client, Info: AppInfo{Port: 4000, Token: "t"}, OpenURL: func(u string) error { opened = append(opened, u); return nil }}
	if err := RunMenuAction(context.Background(), env, "review:chatgpt:"+gptID); err != nil { t.Fatal(err) }
	if len(opened) != 1 || !strings.HasSuffix(opened[0], "&chatgpt_action="+gptID) || strings.Contains(opened[0], "#") { t.Fatal(opened) }
}

func TestChatgptDeclineOnGoneActionIsReported(t *testing.T) {
	client := AppClient{HTTPClient: &http.Client{Transport: roundTripFunc(func(*http.Request) (*http.Response, error) { return reply(404, `{"code":"not_found"}`), nil })}}
	err := HandleAction(context.Background(), client, AppInfo{Port: 1, Token: "t"}, "chatgpt:"+gptID, ActionDecline, func(string) error { return nil })
	if err != ErrRequestGone { t.Fatalf("%v", err) }
}
