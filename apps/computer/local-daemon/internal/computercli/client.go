package computercli

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/url"
	"slices"
	"time"

	"github.com/simplexai-labs/linger/apps/computer/local-daemon/internal/linger/control"
)

// controlClient is the Daemon's local control API.
type controlClient interface {
	Status(context.Context) (object, error)
	Runtimes(context.Context) ([]object, error)
	Runners(context.Context) ([]object, error)
	Runner(ctx context.Context, agentID string) (object, error)
	StopRunner(ctx context.Context, agentID string) (object, error)
	Services(context.Context) ([]object, error)
	StartService(context.Context, control.ServiceStart) (object, error)
	StopService(ctx context.Context, name string) (object, error)
	Shutdown(context.Context) (object, error)
	ShutdownIfIdle(context.Context) (object, error)
}

// controlError is an error envelope the Daemon returned.
type controlError struct {
	Code    string
	Message string
	Status  int
}

func (e *controlError) Error() string { return e.Message }

const controlTimeout = 5 * time.Second

type daemonClient struct{ stateDirectory string }

func newDaemonClient(stateDirectory string) controlClient {
	return daemonClient{stateDirectory: stateDirectory}
}

func (c daemonClient) Status(ctx context.Context) (object, error) {
	return c.object(ctx, http.MethodGet, "/status", nil)
}

func (c daemonClient) Runtimes(ctx context.Context) ([]object, error) {
	values, err := c.list(ctx, "/runtimes")
	return slices.DeleteFunc(values, func(value object) bool {
		runtimeType, _ := value.string("type")
		return !slices.Contains(runtimeTypes, runtimeType)
	}), err
}

func (c daemonClient) Runners(ctx context.Context) ([]object, error) { return c.list(ctx, "/runners") }

func (c daemonClient) Runner(ctx context.Context, agentID string) (object, error) {
	return c.object(ctx, http.MethodGet, "/runners/"+url.PathEscape(agentID), nil)
}

func (c daemonClient) StopRunner(ctx context.Context, agentID string) (object, error) {
	return c.object(ctx, http.MethodPost, "/runners/"+url.PathEscape(agentID)+"/stop", nil)
}

func (c daemonClient) Services(ctx context.Context) ([]object, error) {
	return c.list(ctx, "/services")
}

func (c daemonClient) StartService(ctx context.Context, input control.ServiceStart) (object, error) {
	if input.Args == nil {
		input.Args = []string{}
	}
	body, err := json.Marshal(input)
	if err != nil {
		return nil, err
	}
	return c.object(ctx, http.MethodPost, "/services", body)
}

func (c daemonClient) StopService(ctx context.Context, name string) (object, error) {
	return c.object(ctx, http.MethodPost, "/services/"+url.PathEscape(name)+"/stop", nil)
}

func (c daemonClient) Shutdown(ctx context.Context) (object, error) {
	return c.object(ctx, http.MethodPost, "/shutdown", nil)
}

func (c daemonClient) ShutdownIfIdle(ctx context.Context) (object, error) {
	return c.object(ctx, http.MethodPost, "/shutdown-if-idle", nil)
}

func (c daemonClient) object(ctx context.Context, method, path string, body []byte) (object, error) {
	data, err := c.send(ctx, method, path, body)
	if err != nil {
		return nil, err
	}
	return decodeObject(data)
}

func (c daemonClient) list(ctx context.Context, path string) ([]object, error) {
	data, err := c.send(ctx, http.MethodGet, path, nil)
	if err != nil {
		return nil, err
	}
	if string(data) == "null" {
		return []object{}, nil
	}
	return decodeObjects(data)
}

func (c daemonClient) send(ctx context.Context, method, path string, body []byte) (json.RawMessage, error) {
	ctx, cancel := context.WithTimeout(ctx, controlTimeout)
	defer cancel()
	response, err := control.Call(ctx, c.stateDirectory, method, path, body)
	if errors.Is(err, context.DeadlineExceeded) {
		return nil, errors.New("Computer daemon control request timed out")
	}
	if err != nil {
		return nil, err
	}
	var envelope struct {
		OK    bool            `json:"ok"`
		Data  json.RawMessage `json:"data"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body, &envelope); err != nil {
		return nil, err
	}
	if !envelope.OK {
		return nil, &controlError{Code: envelope.Error.Code, Message: envelope.Error.Message, Status: response.Status}
	}
	return envelope.Data, nil
}
