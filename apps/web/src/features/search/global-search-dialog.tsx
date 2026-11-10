import { ModalDialog } from "@/components/ui/modal-dialog";
import { useTeamHubRuntime } from "@/features/teamhub/teamhub-runtime";

import { SCOPES } from "./global-search-model";
import {
  GlobalSearchField,
  GlobalSearchFooter,
  GlobalSearchResultList,
} from "./global-search-sections";
import {
  useOpenResult,
  useRecordRecentQuery,
  useVoiceSearchBridge,
} from "./use-global-search-actions";
import {
  useActiveRow,
  usePointerSteering,
} from "./use-global-search-navigation";
import {
  useGlobalSearchState,
  useResultSections,
  useSearchGroups,
} from "./use-global-search-results";

export function GlobalSearchDialog({
  initialQuery = "",
  onClose,
  tenantId,
}: {
  /** Opens with this text already searched, as a spoken search does. */
  initialQuery?: string;
  onClose: () => void;
  tenantId: string;
}) {
  const { client } = useTeamHubRuntime();
  const {
    debounced,
    enterScope,
    inputRef,
    query,
    runQuery,
    setQuery,
    setStore,
    setTab,
    store,
    tab,
  } = useGlobalSearchState(initialQuery, tenantId);
  const debouncedQuery = debounced.normalized;
  const {
    directRoomIdByPeer,
    docsLoading,
    error,
    groups,
    messagesLoading,
    pending,
    targetContext,
  } = useSearchGroups({ client, debouncedQuery, tab, tenantId });
  const { layoutKey, rows, rowsKey, sections, showingStart } =
    useResultSections({
      debouncedQuery,
      docsLoading,
      groups,
      messagesLoading,
      setStore,
      store,
      tab,
      tenantId,
    });
  const { openError, openResult } = useOpenResult({
    client,
    debouncedRaw: debounced.raw,
    directRoomIdByPeer,
    enterScope,
    onClose,
    query,
    runQuery,
    setStore,
    targetContext,
    tenantId,
  });
  const activeRow = useActiveRow({
    layoutKey,
    onClose,
    openResult,
    query,
    rows,
    rowsKey,
    setTab,
    tab,
  });
  useRecordRecentQuery({
    debouncedRaw: debounced.raw,
    hasResults: rows.length > 0 && !showingStart,
    pending,
    setStore,
    tenantId,
  });
  useVoiceSearchBridge({
    onClose,
    openResult,
    rows,
    setQuery,
    setTab,
    targetContext,
  });
  const { hoverRow, onListLeave, onListScroll } = usePointerSteering(activeRow);

  const scope = tab === "all" ? undefined : SCOPES[tab];

  return (
    <ModalDialog
      ariaLabel="Search"
      className="global-search flex flex-col overflow-hidden"
      closeOnBackdrop
      onClose={onClose}
      size="md"
    >
      <GlobalSearchField
        activeIndex={activeRow.activeIndex}
        enterScope={enterScope}
        inputRef={inputRef}
        onClose={onClose}
        onInputKeyDown={activeRow.onInputKeyDown}
        onQueryChange={(value) => {
          setQuery(value);
          activeRow.setHighlightShown(true);
        }}
        pending={pending}
        query={query}
        rowCount={rows.length}
        scope={scope}
        tab={tab}
      />
      <GlobalSearchResultList
        activeIndex={activeRow.activeIndex}
        debouncedQuery={debouncedQuery}
        debouncedRaw={debounced.raw}
        enterScope={enterScope}
        error={error}
        highlightShown={activeRow.highlightShown}
        hoverRow={hoverRow}
        indicatorRef={activeRow.indicatorRef}
        inputRef={inputRef}
        listRef={activeRow.listRef}
        onListLeave={onListLeave}
        onListScroll={onListScroll}
        openResult={openResult}
        scope={scope}
        sections={sections}
        tab={tab}
        targetContext={targetContext}
      />
      <GlobalSearchFooter openError={openError} />
    </ModalDialog>
  );
}
