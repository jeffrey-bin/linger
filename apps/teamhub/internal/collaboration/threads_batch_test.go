package collaboration

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/simplexai-labs/linger/apps/teamhub/internal/store"
)

type threadBatchDB struct {
	store.DBTX
	summaries, authors [][]any
	calls              int
	failAt             int
}

func (db *threadBatchDB) Query(_ context.Context, query string, args ...any) (pgx.Rows, error) {
	db.calls++
	if db.calls == db.failAt {
		return nil, errors.New("query failed")
	}
	switch {
	case strings.Contains(query, "-- name: ListMessageThreadSummaries "):
		if args[0] != "parent" {
			return nil, fmt.Errorf("unexpected parent: %v", args[0])
		}
		return &threadBatchRows{values: db.summaries}, nil
	case strings.Contains(query, "-- name: ListLatestThreadReplyAuthorsBatch "):
		var want []string
		for _, row := range db.summaries {
			want = append(want, row[1].(string))
		}
		if !reflect.DeepEqual(args[0], want) {
			return nil, fmt.Errorf("queried outside selected Threads: %v want %v", args[0], want)
		}
		return &threadBatchRows{values: db.authors}, nil
	default:
		return nil, fmt.Errorf("unexpected query: %s", query)
	}
}

type threadBatchRows struct {
	pgx.Rows
	values [][]any
	index  int
}

func (r *threadBatchRows) Close()     {}
func (r *threadBatchRows) Err() error { return nil }
func (r *threadBatchRows) Next() bool { return r.index < len(r.values) }
func (r *threadBatchRows) Scan(dest ...any) error {
	for i, value := range r.values[r.index] {
		if value != nil {
			reflect.ValueOf(dest[i]).Elem().Set(reflect.ValueOf(value))
		}
	}
	r.index++
	return nil
}

func TestHydrateMessageThreadSummariesBatch(t *testing.T) {
	for _, count := range []int{0, 1, 20} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			db := &threadBatchDB{}
			for i := 0; i < count; i++ {
				roomID := fmt.Sprintf("thread-%d", i)
				db.summaries = append(db.summaries, []any{fmt.Sprintf("root-%d", i), roomID, int64(i), nil})
				if i == 0 { // Empty Threads must still produce a summary without authors.
					continue
				}
				for _, id := range []string{"newest", "second", "third"} {
					db.authors = append(db.authors, []any{roomID, id, "tenant", "human", id, pgtype.Text{}, pgtype.Text{}, pgtype.Timestamptz{}})
				}
			}
			a := &Service{queries: store.New(db)}
			result, err := a.hydrateMessageThreadSummaries(t.Context(), "parent", []string{"selected"})
			wantQueries := 1
			if count > 0 {
				wantQueries = 2
			}
			if err != nil || db.calls != wantQueries || len(result) != count {
				t.Fatalf("summaries=%v queries=%d want=%d err=%v", result, db.calls, wantQueries, err)
			}
			for root, summary := range result {
				if root == "root-0" {
					if summary.LatestReplyAuthors != nil || summary.LatestReplyAt != nil || summary.ReplyCount != 0 {
						t.Fatalf("empty Thread changed: %+v", summary)
					}
					continue
				}
				if summary.LatestReplyAuthors == nil || len(*summary.LatestReplyAuthors) != 3 {
					t.Fatalf("missing authors: %+v", summary)
				}
				for i, want := range []string{"newest", "second", "third"} {
					if (*summary.LatestReplyAuthors)[i].Id != want {
						t.Fatalf("author order changed: %+v", summary.LatestReplyAuthors)
					}
				}
			}
		})
	}
}

func TestHydrateMessageThreadSummariesEmptyAndFailures(t *testing.T) {
	db := &threadBatchDB{}
	a := &Service{queries: store.New(db)}
	if result, err := a.hydrateMessageThreadSummaries(t.Context(), "parent", nil); err != nil || len(result) != 0 || db.calls != 0 {
		t.Fatalf("empty page queried database: %v %v calls=%d", result, err, db.calls)
	}
	for _, failAt := range []int{1, 2} {
		db := &threadBatchDB{summaries: [][]any{{"root", "thread", int64(1), nil}}, failAt: failAt}
		a := &Service{queries: store.New(db)}
		if result, err := a.hydrateMessageThreadSummaries(t.Context(), "parent", []string{"root"}); err == nil || result != nil || db.calls != failAt {
			t.Fatalf("partial results on failure %d: %v %v calls=%d", failAt, result, err, db.calls)
		}
	}
}
