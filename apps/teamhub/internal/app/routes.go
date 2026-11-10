package app

import (
	"fmt"
	"net/http"
	"reflect"
	"strings"

	"github.com/gin-gonic/gin"
	"github.com/oapi-codegen/runtime"
	teamhubagentapi "github.com/simplexai-labs/linger/contracts-go/teamhubagentapi"
	"github.com/simplexai-labs/linger/contracts-go/teamhubinternal"
)

// contractRoute mounts one OpenAPI operation on its handler chain. params is
// the zero generated Params struct of an operation that declares query or
// header parameters; the route test keeps it in step with the contract.
type contractRoute struct {
	method   string
	path     string
	params   any
	handlers []gin.HandlerFunc
}

func route(method, path string, params any, handlers ...gin.HandlerFunc) contractRoute {
	return contractRoute{method: method, path: path, params: params, handlers: handlers}
}

// routeGroup holds the operations of one caller: they share the caller's
// credential middleware and the body a malformed parameter is answered with.
type routeGroup struct {
	contract   string
	paramError func(c *gin.Context, params reflect.Type, err error)
	middleware []gin.HandlerFunc
	routes     []contractRoute
}

func (a *App) routeGroups() []routeGroup {
	return []routeGroup{
		{contract: "teamhub-public", paramError: a.writeContractParamError, routes: a.publicRoutes()},
		{
			contract: "teamhub-internal", paramError: a.writeContractParamError,
			middleware: []gin.HandlerFunc{a.agentAPITarget}, routes: a.agentServiceRoutes(),
		},
		{
			contract: "teamhub-internal",
			paramError: func(c *gin.Context, _ reflect.Type, _ error) {
				a.writeMcpContextError(c, http.StatusBadRequest, teamhubinternal.McpContextErrorCodeInvalidRequest, "MCP Context request parameters are invalid")
			},
			middleware: []gin.HandlerFunc{a.agentAPITarget}, routes: a.mcpContextRoutes(),
		},
		{
			contract: "teamhub-internal",
			paramError: func(c *gin.Context, _ reflect.Type, _ error) {
				c.JSON(http.StatusBadRequest, teamhubinternal.VoiceError{Code: "INVALID_REQUEST", Message: "Voice Runtime request is invalid"})
			},
			middleware: []gin.HandlerFunc{a.requireVoiceRuntime()}, routes: a.voiceRuntimeRoutes(),
		},
		{
			contract: "teamhub-agent-api",
			paramError: func(c *gin.Context, _ reflect.Type, _ error) {
				a.writeAgentAPIError(c, http.StatusBadRequest, teamhubagentapi.AgentApiErrorCodeInvalidRequest, "Agent API request parameters are invalid")
			},
			middleware: []gin.HandlerFunc{a.agentAPITarget}, routes: a.agentAPIRoutes(),
		},
		{
			contract: "teamhub-agent-api", paramError: a.writeContractParamError,
			middleware: []gin.HandlerFunc{a.agentAPITarget}, routes: a.agentFileRoutes(),
		},
	}
}

// registerContractRoutes binds parameters first, then runs the caller's
// credential middleware and the operation's own handlers.
func (a *App) registerContractRoutes(engine *gin.Engine) {
	for _, group := range a.routeGroups() {
		mountRouteGroup(engine, group)
	}
}

func mountRouteGroup(engine *gin.Engine, group routeGroup) {
	for _, r := range group.routes {
		handlers := make([]gin.HandlerFunc, 0, 1+len(group.middleware)+len(r.handlers))
		if r.params != nil {
			handlers = append(handlers, bindContractParams(reflect.TypeOf(r.params), group.paramError))
		}
		handlers = append(handlers, group.middleware...)
		handlers = append(handlers, r.handlers...)
		engine.Handle(r.method, r.path, handlers...)
	}
}

const contractParamsKey = "teamhub.contract_params"

// contractParams returns the operation parameters its route bound.
func contractParams[T any](c *gin.Context) T {
	return c.MustGet(contractParamsKey).(T)
}

func bindContractParams(params reflect.Type, writeError func(*gin.Context, reflect.Type, error)) gin.HandlerFunc {
	return func(c *gin.Context) {
		value := reflect.New(params).Elem()
		if err := bindParams(c, value); err != nil {
			writeError(c, params, err)
			c.Abort()
			return
		}
		c.Set(contractParamsKey, value.Interface())
	}
}

// bindParams fills a generated Params struct: fields tagged form are query
// parameters, the others are headers; omitempty marks an optional one.
func bindParams(c *gin.Context, params reflect.Value) error {
	query := c.Request.URL.Query()
	for i := range params.NumField() {
		field := params.Type().Field(i)
		if tag, ok := field.Tag.Lookup("form"); ok {
			name, options, _ := strings.Cut(tag, ",")
			err := runtime.BindQueryParameter("form", true, options != "omitempty", name, query, params.Field(i).Addr().Interface())
			if err != nil {
				return fmt.Errorf("Invalid format for parameter %s: %w", name, err)
			}
			continue
		}
		name, options, _ := strings.Cut(field.Tag.Get("json"), ",")
		required := options != "omitempty"
		values, found := c.Request.Header[http.CanonicalHeaderKey(name)]
		if !found {
			if required {
				return fmt.Errorf("Header parameter %s is required, but not found", name)
			}
			continue
		}
		if len(values) != 1 {
			return fmt.Errorf("Expected one value for %s, got %d", name, len(values))
		}
		target := params.Field(i)
		if target.Kind() == reflect.Pointer {
			target.Set(reflect.New(target.Type().Elem()))
			target = target.Elem()
		}
		err := runtime.BindStyledParameterWithOptions("simple", name, values[0], target.Addr().Interface(), runtime.BindStyledParameterOptions{
			ParamLocation: runtime.ParamLocationHeader, Required: required,
		})
		if err != nil {
			return fmt.Errorf("Invalid format for parameter %s: %w", name, err)
		}
	}
	return nil
}

// writeContractParamError answers with the TeamHub error body. When the
// operation requires an Idempotency-Key and the request lacks exactly one
// valid key, the key is at fault; otherwise another parameter is.
func (a *App) writeContractParamError(c *gin.Context, params reflect.Type, err error) {
	code := "INVALID_REQUEST"
	if field, ok := params.FieldByName("IdempotencyKey"); ok && field.Tag.Get("json") == "Idempotency-Key" {
		values := c.Request.Header.Values("Idempotency-Key")
		if len(values) != 1 || !idempotencyKeyPattern.MatchString(values[0]) {
			code = "INVALID_IDEMPOTENCY_KEY"
		}
	}
	a.writeError(c, http.StatusBadRequest, code, err.Error())
}

// requireValidIdempotencyKey rejects a malformed Idempotency-Key once the
// caller is authenticated; binding already required exactly one value.
func (a *App) requireValidIdempotencyKey(c *gin.Context) {
	if !idempotencyKeyPattern.MatchString(c.GetHeader("Idempotency-Key")) {
		a.writeError(c, http.StatusBadRequest, "INVALID_IDEMPOTENCY_KEY", "a valid Idempotency-Key is required")
		c.Abort()
	}
}
