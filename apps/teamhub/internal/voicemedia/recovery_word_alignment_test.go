package voicemedia

import (
	"reflect"
	"strings"
	"testing"

	"github.com/simplexai-labs/linger/apps/teamhub/internal/voicetranscription"
)

type archiveTestWord struct {
	text       string
	start, end int64
}

func archiveTestSegment(t *testing.T, text string, start, end int64, parts ...archiveTestWord) voicetranscription.StreamingResult {
	t.Helper()
	result := voicetranscription.StreamingResult{Text: text, StartMS: start, EndMS: end, Final: true}
	cursor := 0
	for _, part := range parts {
		index := strings.Index(text[cursor:], part.text)
		if index < 0 {
			t.Fatal("fixture word not found")
		}
		index += cursor
		result.Words = append(result.Words, voicetranscription.TimedWord{TextStart: index, TextEnd: index + len(part.text), StartMS: part.start, EndMS: part.end})
		cursor = index + len(part.text)
	}
	return result
}
func TestRecoveryWordAnchorRepairsNonmatchingSuffix(t *testing.T) {
	left := archiveTestSegment(t, "ァアィイゥウェ，エォオカガ", 93000, 110000, archiveTestWord{"ァアィイゥウェ", 93000, 108000}, archiveTestWord{"エォ", 108000, 109000}, archiveTestWord{"オカガ", 109000, 110000})
	right := archiveTestSegment(t, "エォオカキギクグケゲコゴ", 108000, 115000, archiveTestWord{"エォ", 108020, 109020}, archiveTestWord{"オカキ", 109020, 110500}, archiveTestWord{"ギクグケゲコゴ", 110500, 115000})
	result, err := mergeRecoverySegments([]voicetranscription.StreamingResult{left}, []voicetranscription.StreamingResult{right}, 110000)
	if err != nil || len(result) != 1 || result[0].Text != "ァアィイゥウェ，エォオカキギクグケゲコゴ" {
		t.Fatalf("complete time anchor failed to repair overlap: err=%v", err)
	}
	if _, valid := recoveryWordCharacters(result[0]); !valid {
		t.Fatal("splice lost its original text/word mapping")
	}
	if left.Text != "ァアィイゥウェ，エォオカガ" {
		t.Fatal("unpublished block mutation changed source evidence")
	}
	// Provider word timing can extend beyond its utterance container; do not
	// drop a complete anchored continuation because only that envelope regressed.
	right.EndMS = 109999
	if result, err := mergeRecoverySegments([]voicetranscription.StreamingResult{left}, []voicetranscription.StreamingResult{right}, 110000); err != nil || len(result) != 1 || result[0].Text != "ァアィイゥウェ，エォオカキギクグケゲコゴ" {
		t.Fatal("utterance envelope discarded reliable word evidence")
	}
}
func TestRecoveryWordAnchorPreservesActualRepetition(t *testing.T) {
	left := archiveTestSegment(t, "アィコサザアィコサ", 105000, 109000, archiveTestWord{"アィ", 105000, 105500}, archiveTestWord{"コサ", 105500, 106000}, archiveTestWord{"ザ", 106000, 106300}, archiveTestWord{"アィ", 108000, 108500}, archiveTestWord{"コサ", 108500, 109000})
	right := archiveTestSegment(t, "アィコサシクグケ", 108000, 115000, archiveTestWord{"アィ", 108030, 108500}, archiveTestWord{"コサ", 108500, 109000}, archiveTestWord{"シクグケ", 109000, 115000})
	result, err := mergeRecoverySegments([]voicetranscription.StreamingResult{left}, []voicetranscription.StreamingResult{right}, 110000)
	if err != nil || len(result) != 1 || result[0].Text != "アィコサザアィコサシクグケ" {
		t.Fatal("word anchor removed genuine repeated speech")
	}
}

func TestRecoveryKeepsConfirmedSuffixWithRegressedWordEnd(t *testing.T) {
	left := archiveTestSegment(t, "ジスズセゼソゾタ。", 28362, 33742,
		archiveTestWord{"ジス", 30000, 31722},
		archiveTestWord{"ズ", 31762, 31882}, archiveTestWord{"セ", 32002, 32242},
		archiveTestWord{"ゼ", 32282, 32482}, archiveTestWord{"ソ", 32642, 32842},
		archiveTestWord{"ゾ", 32842, 33042}, archiveTestWord{"タ", 33042, 33362})
	right := archiveTestSegment(t, "ズセゼソゾタ。", 31748, 34210,
		archiveTestWord{"ズ", 31868, 31908}, archiveTestWord{"セ", 32108, 32188},
		archiveTestWord{"ゼ", 32388, 32428}, archiveTestWord{"ソ", 32628, 32868},
		archiveTestWord{"ゾ", 32868, 33068}, archiveTestWord{"タ", 33068, 33348})
	next := archiveTestSegment(t, "ゲコダ。", 35260, 43040, archiveTestWord{"ゲコダ", 35260, 43000})
	// The new block's envelope crosses 33748, but every word is a confirmed
	// repeated suffix before it. The last word ends 14ms earlier this time.
	result, err := mergeRecoverySegments([]voicetranscription.StreamingResult{left}, []voicetranscription.StreamingResult{right, next}, 33748)
	if err != nil || !reflect.DeepEqual(result, []voicetranscription.StreamingResult{left, next}) {
		t.Fatalf("confirmed overlap changed source words or lost the next sentence: err=%v", err)
	}
	for name, text := range map[string]string{"changed-tail": "ズセゼソゾチ。", "missing-tail": "ズセゼソゾ。"} {
		t.Run(name, func(t *testing.T) {
			changed := right
			changed.Text = text
			if text == "ズセゼソゾ。" {
				changed.Words = append([]voicetranscription.TimedWord(nil), right.Words[:5]...)
			}
			if _, err := mergeRecoverySegments([]voicetranscription.StreamingResult{left}, []voicetranscription.StreamingResult{changed}, 33748); err == nil {
				t.Fatal("unmatched or missing tail was treated as fully repeated")
			}
		})
	}
	t.Run("no-time-overlap", func(t *testing.T) {
		changed := right
		changed.Words = append([]voicetranscription.TimedWord(nil), right.Words...)
		changed.Words[0].StartMS, changed.Words[0].EndMS = 31900, 31980
		if _, err := mergeRecoverySegments([]voicetranscription.StreamingResult{left}, []voicetranscription.StreamingResult{changed}, 33748); err == nil {
			t.Fatal("matching text without complete word time evidence was accepted")
		}
	})
	t.Run("post-boundary-word", func(t *testing.T) {
		changed := right
		changed.Words = append([]voicetranscription.TimedWord(nil), right.Words...)
		changed.Words[len(changed.Words)-1].EndMS = 34000
		result, err := mergeRecoverySegments([]voicetranscription.StreamingResult{left}, []voicetranscription.StreamingResult{changed}, 33748)
		if err != nil || len(result) != 1 || result[0].Words[len(result[0].Words)-1].EndMS != 34000 {
			t.Fatal("post-boundary word evidence was dropped as a covered duplicate")
		}
	})
	continued := right
	continued.Text = "ズセゼソゾタグケ。"
	continued.EndMS = 35000
	continued.Words = append(append([]voicetranscription.TimedWord(nil), right.Words...), voicetranscription.TimedWord{TextStart: len("ズセゼソゾタ"), TextEnd: len("ズセゼソゾタグケ"), StartMS: 34000, EndMS: 35000})
	result, err = mergeRecoverySegments([]voicetranscription.StreamingResult{left}, []voicetranscription.StreamingResult{continued}, 33748)
	if err != nil || len(result) != 1 || result[0].Text != "ジスズセゼソゾタグケ。" {
		t.Fatal("incoming continuation was discarded with the repeated suffix")
	}
}

func TestRecoveryRejectsAmbiguousOrInvalidWordAnchors(t *testing.T) {
	left := archiveTestSegment(t, "ジス", 108000, 110000, archiveTestWord{"ジス", 108000, 109000})
	cases := map[string]voicetranscription.StreamingResult{
		"ambiguous":       archiveTestSegment(t, "ジスジスグケ", 108000, 115000, archiveTestWord{"ジス", 108000, 108500}, archiveTestWord{"ジス", 108500, 109000}, archiveTestWord{"グケ", 110000, 115000}),
		"no-time-overlap": archiveTestSegment(t, "ジスグケ", 108000, 115000, archiveTestWord{"ジス", 109000, 110000}, archiveTestWord{"グケ", 110000, 115000}),
		"zero-time":       archiveTestSegment(t, "ジスグケ", 108000, 115000, archiveTestWord{"ジス", 108000, 108000}, archiveTestWord{"グケ", 110000, 115000}),
		"incomplete-word": archiveTestSegment(t, "ジスズグケ", 108000, 115000, archiveTestWord{"ジスズ", 108000, 109000}, archiveTestWord{"グケ", 110000, 115000}),
	}
	for name, right := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := mergeRecoverySegments([]voicetranscription.StreamingResult{left}, []voicetranscription.StreamingResult{right}, 110000); err == nil {
				t.Fatal("unproven word correspondence was published")
			}
		})
	}
}
func TestRecoveryWordOffsetsRetainProviderEvidence(t *testing.T) {
	segment := archiveTestSegment(t, "ヂッツ", 0, 2002, archiveTestWord{"ヂッツ", 80, 1980})
	segments := []voicetranscription.StreamingResult{segment}
	offsetRecoverySegments(segments, 108000, 110000)
	if segments[0].StartMS != 108000 || segments[0].EndMS != 110000 || segments[0].Words[0].StartMS != 108080 || segments[0].Words[0].EndMS != 109980 {
		t.Fatal("word media time was not mapped to archive coordinates")
	}
}
