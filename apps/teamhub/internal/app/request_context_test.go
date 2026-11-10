package app

import "testing"

func TestShouldLogHTTPRequest(t *testing.T) {
	t.Parallel()

	tests := []struct {
		name   string
		path   string
		status int
		want   bool
	}{
		{name: "ordinary success", path: "/v0/account", status: 200, want: true},
		{name: "preview capability token", path: "/v0/document-previews/secret-token/index.html", status: 404, want: false},
		{name: "task claim empty", path: "/v0/task-execution-claims", status: 204, want: false},
		{name: "task claimed", path: "/v0/task-execution-claims", status: 200, want: true},
		{name: "task claim failure", path: "/v0/task-execution-claims", status: 503, want: true},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			t.Parallel()
			if got := shouldLogHTTPRequest(test.path, test.status); got != test.want {
				t.Fatalf("shouldLogHTTPRequest(%q, %d) = %t, want %t", test.path, test.status, got, test.want)
			}
		})
	}
}
