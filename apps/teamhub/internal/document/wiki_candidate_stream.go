package document

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"slices"

	"github.com/simplexai-labs/linger/contracts-go/nodeservicesinternal"
)

// Match the existing receiver limit. Admission counts the encoded envelope,
// including Base64 and metadata, before loading any frozen source bytes.
const maxWikiCandidateRequestBytes = 256 << 20

type wikiRequestWriter struct {
	writer io.Writer
	count  int64
	probe  bool
	err    error
}

func (w *wikiRequestWriter) write(value []byte) {
	if w.err != nil {
		return
	}
	w.count += int64(len(value))
	if !w.probe {
		n, err := w.writer.Write(value)
		w.err = err
		if n != len(value) && err == nil {
			w.err = io.ErrShortWrite
		}
	}
}

func (w *wikiRequestWriter) text(value string) { w.write([]byte(value)) }

func (w *wikiRequestWriter) json(value any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		w.err = err
		return
	}
	w.write(encoded)
}

func (w *wikiRequestWriter) binary(ctx context.Context, metadata any, field string, size int64, read func(context.Context) ([]byte, error), digest string) {
	if w.err != nil {
		return
	}
	encoded, err := json.Marshal(metadata)
	if err != nil {
		w.err = err
		return
	}
	marker := []byte(fmt.Sprintf("%q:null", field))
	prefix, suffix, found := bytes.Cut(encoded, marker)
	if !found {
		w.err = fmt.Errorf("Wiki binary field %s is missing", field)
		return
	}
	w.write(prefix)
	w.text(fmt.Sprintf("%q:\"", field))
	if w.probe {
		w.count += (size + 2) / 3 * 4
	} else {
		content, err := read(ctx)
		if err != nil {
			w.err = err
			return
		}
		if !exactContentMatches(content, size, digest) {
			w.err = ErrInvalidInput
			return
		}
		encoder := base64.NewEncoder(base64.StdEncoding, w.writer)
		_, err = io.Copy(encoder, bytes.NewReader(content))
		closeErr := encoder.Close()
		if err != nil {
			w.err = err
		} else {
			w.err = closeErr
		}
	}
	w.text("\"")
	w.write(suffix)
}

func writeWikiCandidateRequest(ctx context.Context, w *wikiRequestWriter, request WikiCandidateGenerationRequest) error {
	removed := make([]nodeservicesinternal.WikiRefreshSourceReference, len(request.Changes.Removed))
	for index, source := range request.Changes.Removed {
		removed[index] = nodeservicesinternal.WikiRefreshSourceReference{DocumentId: source.DocumentID, DocumentVersionId: source.DocumentVersionID, Filename: SafeSourceFilename(source.Filename)}
	}
	// Generate scalar fields from the contract DTO; stream the two content arrays.
	metadata, err := json.Marshal(nodeservicesinternal.WikiRefreshCandidateGenerationRequest{
		GeneratorAgentActorId: request.GeneratorAgentActorID,
		Mode:                  nodeservicesinternal.WikiRefreshCandidateGenerationRequestMode(request.Mode),
		TenantId:              request.TenantID, WikiRefreshId: request.RefreshID,
	})
	if err != nil {
		return err
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(metadata, &fields); err != nil {
		return err
	}
	keys := make([]string, 0, len(fields))
	for key := range fields {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	w.text("{")
	for index, key := range keys {
		if index > 0 {
			w.text(",")
		}
		w.json(key)
		w.text(":")
		switch key {
		case "base_pages":
			w.text("[")
			for pageIndex, page := range request.BasePages {
				if pageIndex > 0 {
					w.text(",")
				}
				w.binary(ctx, nodeservicesinternal.WikiRefreshBasePage{PageKey: page.PageKey, MarkdownSha256: page.SHA256}, "markdown_content", page.SizeBytes, page.ReadContent, page.SHA256)
			}
			w.text("]")
		case "changes":
			w.text("{\"added\":")
			writeWikiSourceArray(ctx, w, request.Changes.Added)
			w.text(",\"modified\":")
			writeWikiSourceArray(ctx, w, request.Changes.Modified)
			w.text(",\"removed\":")
			w.json(removed)
			w.text("}")
		default:
			w.write(fields[key])
		}
	}
	w.text("}")
	return w.err
}

func writeWikiSourceArray(ctx context.Context, w *wikiRequestWriter, sources []WikiCandidateSource) {
	w.text("[")
	for index, source := range sources {
		if index > 0 {
			w.text(",")
		}
		metadata := wikiFrozenSource(source)
		metadata.Content = nil
		w.binary(ctx, metadata, "content", source.SizeBytes, source.ReadContent, source.SHA256)
	}
	w.text("]")
}
