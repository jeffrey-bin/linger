package roomagent

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
)

const computerPermissionStatusBody = `{"platform":"darwin","host":"desktop","subjects":[
{"subject":"linger","permissions":[{"id":"screen_recording","state":"granted","prompt":"available","relaunch_required":false},
{"id":"accessibility","state":"denied","prompt":"available","relaunch_required":false}]},
{"subject":"computer_use","permissions":[{"id":"screen_recording","state":"not_determined","prompt":"available","relaunch_required":false}]}]}`

func TestHTTPGatewayActsOnOwnedComputerPermissions(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/tenants/tenant_1/owners/actor_owner/local-computers/computer_1/permissions" {
			t.Fatalf("path=%s", r.URL.Path)
		}
		if r.Method == http.MethodPost {
			var body map[string]string
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Fatal(err)
			}
			if len(body) != 3 || body["action"] != "prompt" || body["subject"] != "linger" || body["permission"] != "accessibility" {
				t.Fatalf("body=%v", body)
			}
		} else if r.Method != http.MethodGet {
			t.Fatalf("method=%s", r.Method)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(computerPermissionStatusBody))
	}))
	t.Cleanup(server.Close)
	gateway, err := NewHTTPGateway(server.URL, "service-secret", server.Client())
	if err != nil {
		t.Fatal(err)
	}
	for _, command := range []LocalComputerPermissionCommand{
		{Action: LocalComputerPermissionStatusAction},
		{Action: LocalComputerPermissionPrompt, Subject: "linger", Permission: "accessibility"},
	} {
		command.TenantID, command.OwnerActorID, command.ComputerID = "tenant_1", "actor_owner", "computer_1"
		status, err := gateway.LocalComputerPermissions(context.Background(), command)
		if err != nil || status.Platform != "darwin" || status.Host != "desktop" || len(status.Subjects) != 2 ||
			status.Subjects[0].Permissions[1].State != "denied" {
			t.Fatalf("action=%s status=%+v err=%v", command.Action, status, err)
		}
		if !status.Granted("linger", []string{"screen_recording"}) || status.Granted("linger", []string{"screen_recording", "accessibility"}) ||
			status.Granted("computer_use", []string{"screen_recording"}) || status.Granted("computer_use", []string{"accessibility"}) {
			t.Fatalf("granted read wrong for %+v", status)
		}
	}
	if !(LocalComputerPermissionStatus{Platform: "linux"}).Granted("linger", []string{"screen_recording"}) {
		t.Fatal("a Computer that is not a Mac needs no macOS permission")
	}
}

func TestHTTPGatewayMapsComputerPermissionFailures(t *testing.T) {
	for _, test := range []struct {
		status int
		body   string
		want   error
	}{
		{http.StatusNotFound, `{"error":{"code":"LOCAL_COMPUTER_NOT_FOUND","message":"x","request_id":"r"}}`, ErrLocalComputerNotFound},
		{http.StatusConflict, `{"error":{"code":"COMPUTER_PERMISSION_CAPABILITY_UNAVAILABLE","message":"x","request_id":"r"}}`, ErrLocalComputerPermissionsUnsupported},
		{http.StatusBadGateway, `{"error":{"code":"COMPUTER_PERMISSION_UNAVAILABLE","message":"x","request_id":"r"}}`, &LocalComputerPermissionError{Code: "COMPUTER_PERMISSION_UNAVAILABLE"}},
		{http.StatusServiceUnavailable, `{"error":{"code":"LOCAL_COMPUTER_OFFLINE","message":"x","request_id":"r"}}`, ErrLocalComputerOffline},
		{http.StatusServiceUnavailable, `{"error":{"code":"COMPUTER_PERMISSION_TIMEOUT","message":"x","request_id":"r"}}`, ErrLocalComputerPermissionTimeout},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(test.status)
			_, _ = w.Write([]byte(test.body))
		}))
		gateway, err := NewHTTPGateway(server.URL, "service-secret", server.Client())
		if err != nil {
			t.Fatal(err)
		}
		_, err = gateway.LocalComputerPermissions(context.Background(), LocalComputerPermissionCommand{
			TenantID: "tenant_1", OwnerActorID: "actor_owner", ComputerID: "computer_1", Action: LocalComputerPermissionRelaunch, Subject: "linger",
		})
		server.Close()
		var typed *LocalComputerPermissionError
		if errors.As(test.want, &typed) {
			var got *LocalComputerPermissionError
			if !errors.As(err, &got) || got.Code != typed.Code || !errors.Is(err, ErrLocalComputerPermissionFailed) {
				t.Fatalf("status=%d err=%v want code %s", test.status, err, typed.Code)
			}
			continue
		}
		if !errors.Is(err, test.want) {
			t.Fatalf("status=%d err=%v want %v", test.status, err, test.want)
		}
	}
}
