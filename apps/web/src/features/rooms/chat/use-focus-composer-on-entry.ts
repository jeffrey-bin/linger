import { useEffect } from "react";
import { useLocation, useNavigate } from "react-router";

export function useFocusComposerOnEntry(enabled = true) {
  const location = useLocation();
  const navigate = useNavigate();
  const focusComposer = location.state?.focusComposer === true;

  useEffect(() => {
    if (!focusComposer || !enabled) return;

    void navigate(
      {
        hash: location.hash,
        pathname: location.pathname,
        search: location.search,
      },
      { replace: true, state: null },
    );
  }, [
    focusComposer,
    enabled,
    location.hash,
    location.pathname,
    location.search,
    navigate,
  ]);

  return focusComposer && enabled;
}
