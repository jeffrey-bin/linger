package app

import (
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"

	"github.com/gin-gonic/gin"
	"gopkg.in/yaml.v3"
)

const repositoryRoot = "../../../.."

// specOperation is one OpenAPI operation as the route table must mount it.
type specOperation struct {
	params []specParam // query and header parameters
}

type specParam struct {
	in, name string
	required bool
}

func (p specParam) String() string {
	return fmt.Sprintf("%s %s required=%t", p.in, p.name, p.required)
}

// servedContracts are the entrypoints of the contracts TeamHub serves; the
// route groups name which of them each route belongs to.
var servedContracts = map[string]string{
	"teamhub-public":    "contracts/openapi/teamhub-public/teamhub-api.openapi.yaml",
	"teamhub-agent-api": "contracts/openapi/teamhub-agent-api/openapi.yaml",
	"teamhub-internal":  "contracts/openapi/teamhub-internal/openapi.yaml",
}

// contractOperations reads every operation of each contract that TeamHub
// serves, keyed by contract and "METHOD /gin/path".
func contractOperations(t *testing.T) map[string]map[string]specOperation {
	t.Helper()
	loader := specLoader{documents: map[string]map[string]any{}}
	contracts := map[string]map[string]specOperation{}
	for id, entrypoint := range servedContracts {
		file := filepath.Join(repositoryRoot, entrypoint)
		operations := map[string]specOperation{}
		paths, _ := loader.document(t, file)["paths"].(map[string]any)
		for path, item := range paths {
			itemFile, resolved := loader.resolve(t, file, item)
			pathItem := resolved.(map[string]any)
			shared := loader.params(t, itemFile, pathItem["parameters"])
			for method, operation := range pathItem {
				if !slices.Contains([]string{"get", "put", "post", "delete", "patch", "head"}, method) {
					continue
				}
				params := append(slices.Clone(shared), loader.params(t, itemFile, operation.(map[string]any)["parameters"])...)
				ginPath := strings.NewReplacer("{", ":", "}", "").Replace(path)
				operations[strings.ToUpper(method)+" "+ginPath] = specOperation{params: params}
			}
		}
		contracts[id] = operations
	}
	return contracts
}

type specLoader struct {
	documents map[string]map[string]any
}

func (l specLoader) read(t *testing.T, file string) []byte {
	t.Helper()
	data, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func (l specLoader) document(t *testing.T, file string) map[string]any {
	t.Helper()
	if document, ok := l.documents[file]; ok {
		return document
	}
	var document map[string]any
	if err := yaml.Unmarshal(l.read(t, file), &document); err != nil {
		t.Fatalf("%s: %v", file, err)
	}
	l.documents[file] = document
	return document
}

// resolve follows $ref chains and returns the file the value lives in.
func (l specLoader) resolve(t *testing.T, file string, value any) (string, any) {
	t.Helper()
	for {
		node, ok := value.(map[string]any)
		if !ok {
			return file, value
		}
		ref, ok := node["$ref"].(string)
		if !ok {
			return file, value
		}
		target, pointer, _ := strings.Cut(ref, "#")
		if target != "" {
			file = filepath.Join(filepath.Dir(file), target)
		}
		value = any(l.document(t, file))
		for _, token := range strings.Split(strings.TrimPrefix(pointer, "/"), "/") {
			if token == "" {
				continue
			}
			token = strings.NewReplacer("~1", "/", "~0", "~").Replace(token)
			value = value.(map[string]any)[token]
		}
	}
}

func (l specLoader) params(t *testing.T, file string, list any) []specParam {
	t.Helper()
	items, _ := list.([]any)
	var params []specParam
	for _, item := range items {
		_, resolved := l.resolve(t, file, item)
		param := resolved.(map[string]any)
		in := param["in"].(string)
		if in != "query" && in != "header" {
			continue
		}
		required, _ := param["required"].(bool)
		params = append(params, specParam{in: in, name: param["name"].(string), required: required})
	}
	return params
}

// boundParams lists the parameters a generated Params struct binds.
func boundParams(params any) []specParam {
	if params == nil {
		return nil
	}
	var bound []specParam
	value := reflect.TypeOf(params)
	for i := range value.NumField() {
		field := value.Field(i)
		in, tag := "query", field.Tag.Get("form")
		if tag == "" {
			in, tag = "header", field.Tag.Get("json")
		}
		name, options, _ := strings.Cut(tag, ",")
		bound = append(bound, specParam{in: in, name: name, required: options != "omitempty"})
	}
	return bound
}

// routeCoverageProblems compares mounted routes with the contracts: every
// operation is mounted once, nothing else is, and each route binds exactly the
// operation's query and header parameters.
func routeCoverageProblems(contracts map[string]map[string]specOperation, groups []routeGroup) []string {
	var problems []string
	mounted := map[string]bool{}
	for _, group := range groups {
		operations, ok := contracts[group.contract]
		if !ok {
			problems = append(problems, "route group for unknown contract "+group.contract)
			continue
		}
		for _, r := range group.routes {
			key := r.method + " " + r.path
			if mounted[group.contract+" "+key] {
				problems = append(problems, group.contract+": mounted twice: "+key)
			}
			mounted[group.contract+" "+key] = true
			operation, ok := operations[key]
			if !ok {
				problems = append(problems, group.contract+": route outside the contract: "+key)
				continue
			}
			sortParams := func(params []specParam) []string {
				out := make([]string, 0, len(params))
				for _, param := range params {
					out = append(out, param.String())
				}
				slices.Sort(out)
				return out
			}
			if want, got := sortParams(operation.params), sortParams(boundParams(r.params)); !slices.Equal(want, got) {
				problems = append(problems, fmt.Sprintf("%s: %s binds %v, contract declares %v", group.contract, key, got, want))
			}
		}
	}
	for contract, operations := range contracts {
		for key := range operations {
			if !mounted[contract+" "+key] {
				problems = append(problems, contract+": operation not mounted: "+key)
			}
		}
	}
	slices.Sort(problems)
	return problems
}

func TestRoutesMountEveryContractOperationExactlyOnce(t *testing.T) {
	contracts := contractOperations(t)
	if problems := routeCoverageProblems(contracts, (&App{}).routeGroups()); len(problems) > 0 {
		t.Fatalf("route table and contracts disagree:\n%s", strings.Join(problems, "\n"))
	}
}

func TestRouteCoverageReportsMissingAndExtraRoutes(t *testing.T) {
	contracts := map[string]map[string]specOperation{
		"api": {"GET /v0/rooms/:roomId": {}, "POST /v0/rooms": {params: []specParam{{in: "header", name: "Idempotency-Key", required: true}}}},
	}
	type keyParams struct {
		IdempotencyKey string `json:"Idempotency-Key"`
	}
	handler := func(*gin.Context) {}
	tests := map[string]struct {
		routes []contractRoute
		want   []string
	}{
		"missing": {
			routes: []contractRoute{route(http.MethodPost, "/v0/rooms", keyParams{}, handler)},
			want:   []string{"api: operation not mounted: GET /v0/rooms/:roomId"},
		},
		"extra": {
			routes: []contractRoute{
				route(http.MethodGet, "/v0/rooms/:roomId", nil, handler),
				route(http.MethodPost, "/v0/rooms", keyParams{}, handler),
				route(http.MethodDelete, "/v0/rooms/:roomId", nil, handler),
			},
			want: []string{"api: route outside the contract: DELETE /v0/rooms/:roomId"},
		},
		"unbound parameters": {
			routes: []contractRoute{
				route(http.MethodGet, "/v0/rooms/:roomId", nil, handler),
				route(http.MethodPost, "/v0/rooms", nil, handler),
			},
			want: []string{"api: POST /v0/rooms binds [], contract declares [header Idempotency-Key required=true]"},
		},
	}
	for name, test := range tests {
		t.Run(name, func(t *testing.T) {
			got := routeCoverageProblems(contracts, []routeGroup{{contract: "api", routes: test.routes}})
			if !slices.Equal(got, test.want) {
				t.Fatalf("problems=%q want=%q", got, test.want)
			}
		})
	}
}

func newPublicContractTestEngine(a *App) *gin.Engine {
	engine := gin.New()
	engine.Use(func(c *gin.Context) { c.Set("request_id", "request-contract-test") })
	mountRouteGroup(engine, routeGroup{paramError: a.writeContractParamError, routes: a.publicRoutes()})
	return engine
}
