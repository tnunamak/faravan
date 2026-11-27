package faravantray

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Lending sends a lending verb (on, off, pause, resume) with an optional body.
func (c AppClient) Lending(ctx context.Context, info AppInfo, verb, payload string) error {
	response, err := c.requestBody(ctx, info, http.MethodPost, "/api/lending/"+verb, payload)
	if err != nil { return err }
	response.Body.Close()
	return nil
}

// ActionEnv is everything a menu click may touch, so a click is testable without a desktop.
type ActionEnv struct {
	Client AppClient
	Info AppInfo
	Now time.Time
	Loc *time.Location
	OpenURL func(string) error
}

// routes are the app pages the menu opens, always through a one-time sign-in link.
var routes = map[string]string{"open": "#/home", "new": "#/new", "settings": "#/lend", "updates": "#/you/updates", "account": "#/you", "watch": "#/jobs", "jobs": "#/jobs", "setup": "#/setup", "fix": "#/lend"}

// The menu binds Watch to the attempt it showed, not whichever job runs at click time.
func (c AppClient) jobRoute(ctx context.Context, info AppInfo, attempt string) (string, error) {
	response, err := c.request(ctx, info, http.MethodGet, "/api/jobs")
	if err != nil { return "", err }
	defer response.Body.Close()
	var jobs []struct {
		Digest string `json:"job_digest"`
		Circle struct { ID string `json:"id"` } `json:"circle"`
		Attempt *struct { ID string `json:"attempt_id"` } `json:"current_attempt"`
	}
	if err := json.NewDecoder(response.Body).Decode(&jobs); err != nil { return "", errors.New("Faravan jobs are unavailable") }
	for _, job := range jobs {
		if job.Attempt != nil && job.Attempt.ID == attempt && job.Digest != "" {
			route := "#/job/" + url.PathEscape(job.Digest)
			if job.Circle.ID != "" { route += "/" + url.PathEscape(job.Circle.ID) }
			return route, nil
		}
	}
	return "", errors.New("the shown job is no longer available")
}

func openRoute(ctx context.Context, env ActionEnv, route string) error {
	link, err := env.Client.Handoff(ctx, env.Info)
	if err != nil { return err }
	return env.OpenURL(link + route)
}

// RunMenuAction carries out one menu line. "Stop Sam’s job…" is not here: it needs a confirmation,
// which the tray shows first (StopJobPrompt), so a bare click can never stop a job.
func RunMenuAction(ctx context.Context, env ActionEnv, id string) error {
	switch {
	case id == "cleanup-retry":
		response, err := env.Client.requestBody(ctx, env.Info, http.MethodPost, "/api/cleanup/retry", "{}")
		if err != nil {
			return err
		}
		defer response.Body.Close()
		var result struct {
			Items []CleanupItem `json:"items"`
			Hold *struct { Message string `json:"message"` } `json:"hold"`
		}
		if err := json.NewDecoder(io.LimitReader(response.Body, 1<<20)).Decode(&result); err != nil {
			return errors.New("Cleanup status could not be read")
		}
		if result.Hold != nil {
			return errors.New(result.Hold.Message)
		}
		if len(result.Items) > 0 {
			messages := []string{}
			for _, item := range result.Items {
				messages = append(messages, item.Message)
			}
			return errors.New(strings.Join(messages, "\n"))
		}
		return nil
	case strings.HasPrefix(id, "watch:"):
		attempt := strings.TrimPrefix(id, "watch:")
		if attempt == "" { return errors.New("no job was shown") }
		route, err := env.Client.jobRoute(ctx, env.Info, attempt)
		if err != nil { return err }
		return openRoute(ctx, env, route)
	case strings.HasPrefix(id, "review:"):
		return HandleAction(ctx, env.Client, env.Info, strings.TrimPrefix(id, "review:"), ActionReview, env.OpenURL)
	case id == "pause-1h":
		return env.Client.Lending(ctx, env.Info, "pause", fmt.Sprintf(`{"until":%d}`, env.Now.Add(time.Hour).UnixMilli()))
	case id == "pause-30m":
		return env.Client.Lending(ctx, env.Info, "pause", fmt.Sprintf(`{"until":%d}`, env.Now.Add(30*time.Minute).UnixMilli()))
	case id == "pause-tomorrow":
		return env.Client.Lending(ctx, env.Info, "pause", fmt.Sprintf(`{"until":%d}`, PauseTomorrow(env.Now, env.Loc).UnixMilli()))
	case id == "pause-after":
		return env.Client.Lending(ctx, env.Info, "pause", "{}")
	case id == "pause-after-job":
		return env.Client.Lending(ctx, env.Info, "pause", "{}")
	case id == "off":
		return env.Client.Lending(ctx, env.Info, "off", "{}")
	case id == "on":
		return env.Client.Lending(ctx, env.Info, "on", "{}")
	case id == "resume":
		return env.Client.Lending(ctx, env.Info, "resume", "{}")
	}
	if route, ok := routes[id]; ok { return openRoute(ctx, env, route) }
	return errors.New("unknown menu action")
}
