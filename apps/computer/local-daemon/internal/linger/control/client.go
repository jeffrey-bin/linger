// Package control serves and calls the Local Computer Daemon's owner-only control
// endpoint and reads the Daemon owner record that identifies its process.
package control

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
)

// Response is one control reply: the HTTP status and its JSON envelope.
type Response struct {
	Status int
	Body   json.RawMessage
}

// Call sends one control request to the Daemon that owns stateDirectory. An
// error wrapping os.ErrNotExist means no Daemon is listening.
func Call(ctx context.Context, stateDirectory, method, requestPath string, body json.RawMessage) (Response, error) {
	if (method != http.MethodGet && method != http.MethodPost) || len(body) > 8192 || (len(body) > 0 && !json.Valid(body)) {
		return Response{}, errors.New("invalid control request")
	}
	uri, err := url.ParseRequestURI(requestPath)
	if err != nil || uri.Host != "" || uri.Scheme != "" || uri.Path == "" || uri.Path[0] != '/' {
		return Response{}, errors.New("invalid control request path")
	}
	dial, err := controlDialer(stateDirectory)
	if err != nil {
		return Response{}, err
	}
	transport := &http.Transport{DisableKeepAlives: true, DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) { return dial(ctx) }}
	defer transport.CloseIdleConnections()
	request, err := http.NewRequestWithContext(ctx, method, "http://control"+requestPath, bytes.NewReader(body))
	if err != nil {
		return Response{}, err
	}
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := (&http.Client{Transport: transport}).Do(request)
	if err != nil {
		return Response{}, err
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1024*1024+1))
	if err != nil {
		return Response{}, err
	}
	if len(data) > 1024*1024 || !json.Valid(data) {
		return Response{}, errors.New("invalid control response")
	}
	return Response{Status: response.StatusCode, Body: data}, nil
}
