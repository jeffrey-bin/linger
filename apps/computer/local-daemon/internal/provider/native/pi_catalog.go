package native

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"os/exec"
	"strconv"
	"strings"
)

var errPiNoModels = errors.New("Pi returned no available models")

// PiRPCResourceArgs is the resource policy shared by managed execution,
// managed catalog discovery and the protocol probe. It returns a new slice.
func PiRPCResourceArgs() []string {
	return []string{"--no-extensions", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-approve"}
}

type piCatalogState struct {
	Model struct {
		ID       string `json:"id"`
		Provider string `json:"provider"`
	} `json:"model"`
	ThinkingLevel string `json:"thinkingLevel"`
}

type piCatalogModel struct {
	ID               string                     `json:"id"`
	Provider         string                     `json:"provider"`
	Reasoning        bool                       `json:"reasoning"`
	ThinkingLevelMap map[string]json.RawMessage `json:"thinkingLevelMap"`
	ContextWindow    json.RawMessage            `json:"contextWindow"`
}

// piThinkingLevels are Pi's levels in catalog order. Optional levels are
// offered only when the model maps them to a non-null value.
var piThinkingLevels = []struct {
	value    string
	optional bool
}{
	{"off", false}, {"minimal", false}, {"low", false}, {"medium", false}, {"high", false},
	{"xhigh", true}, {"max", true},
}

// DiscoverPiModels lists the models managed Pi execution can use. It runs
// Pi under the same resource policy as execution, so no extension can add
// models a managed run would not see.
func DiscoverPiModels(ctx context.Context, invocation Invocation) (ModelList, error) {
	program, err := exec.LookPath(invocation.Program)
	if err != nil {
		return ModelList{}, err
	}
	invocation.Program = program
	args := append([]string{"--mode", "rpc", "--no-session"}, PiRPCResourceArgs()...)
	requests := []any{
		map[string]string{"id": "linger-state", "type": "get_state"},
		map[string]string{"id": "linger-models", "type": "get_available_models"},
	}
	expected := map[string]string{"linger-state": "get_state", "linger-models": "get_available_models"}
	replies := map[string]json.RawMessage{}
	receive := func(frame []byte, _ func(...any) error) (bool, error) {
		reply, isReply := piCatalogReplyFrame(frame)
		if !isReply {
			return false, nil
		}
		command, ok := expected[reply.ID]
		if !ok {
			return false, nil
		}
		if reply.Command != command || !reply.Success {
			return false, errPiNoModels
		}
		replies[reply.ID] = reply.Data
		return len(replies) == len(expected), nil
	}
	if err := exchangeCatalog(ctx, invocation, args, requests, receive); err != nil {
		if errors.Is(err, context.DeadlineExceeded) || errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return ModelList{}, context.DeadlineExceeded
		}
		if errors.Is(err, context.Canceled) || errors.Is(ctx.Err(), context.Canceled) {
			return ModelList{}, context.Canceled
		}
		return ModelList{}, errPiNoModels
	}
	var state piCatalogState
	var available struct {
		Models []json.RawMessage `json:"models"`
	}
	if json.Unmarshal(replies["linger-state"], &state) != nil || json.Unmarshal(replies["linger-models"], &available) != nil {
		return ModelList{}, errPiNoModels
	}
	return piCatalogList(state, available.Models)
}

// piCatalogReplyFrame reports whether frame is a command response. Events
// and other lines are skipped by the catalog exchange.
func piCatalogReplyFrame(frame []byte) (piReplyFrame, bool) {
	var reply piReplyFrame
	if json.Unmarshal(frame, &reply) != nil {
		return reply, false
	}
	return reply, reply.Type == "response"
}

func piCatalogList(state piCatalogState, entries []json.RawMessage) (ModelList, error) {
	defaultKey := ""
	if provider, id := strings.TrimSpace(state.Model.Provider), strings.TrimSpace(state.Model.ID); provider != "" && id != "" {
		defaultKey = provider + "/" + id
	}
	var models catalogModels
	for _, raw := range entries {
		var entry piCatalogModel
		if json.Unmarshal(raw, &entry) != nil {
			return ModelList{}, errPiNoModels
		}
		provider, id := strings.TrimSpace(entry.Provider), strings.TrimSpace(entry.ID)
		if provider == "" || id == "" {
			continue
		}
		key := provider + "/" + id
		option := ModelOption{ID: key, Label: key, Provider: provider, Default: key == defaultKey}
		// A window that is not a whole token count stays unknown.
		if window, err := strconv.Atoi(strings.TrimSpace(string(entry.ContextWindow))); err == nil && window > 0 {
			option.ContextWindow = window
		}
		if entry.Reasoning {
			defaultLevel := ""
			if option.Default {
				defaultLevel = state.ThinkingLevel
			}
			option.Effort = piEffortSupport(entry.ThinkingLevelMap, defaultLevel)
		}
		models.add(option)
	}
	list := models.list()
	if list.Models == nil {
		list.Models = []ModelOption{}
	}
	return list, nil
}

func piEffortSupport(levels map[string]json.RawMessage, defaultLevel string) *EffortSupport {
	var efforts effortCatalog
	for _, level := range piThinkingLevels {
		mapped, present := levels[level.value]
		null := present && bytes.Equal(bytes.TrimSpace(mapped), []byte("null"))
		if level.optional && (!present || null) || !level.optional && null {
			continue
		}
		efforts.add(level.value, "")
	}
	support := efforts.support(defaultLevel)
	if support == nil {
		return nil
	}
	for i := range support.Options {
		if support.Options[i].Value == "off" {
			support.Options[i].Value = "none"
		}
	}
	if support.Default == "off" {
		support.Default = "none"
	}
	return support
}
