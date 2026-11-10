---
name: humanlike-browse
description: Read, survey, post to or manage a site that watches for automated browsing, such as a social network, a marketplace or any site where the user is signed in, through the computer tools in the Computer's own browser. Use whenever a task reads posts, comments, profiles or search results on such a site, or writes there for the user.
---

# Sites that watch for automated browsing

## Choose the route

- A public page that needs no sign-in and no clicks: read it with the web search or fetch tools.
- Anything else on a social network, a marketplace or a site where the user is signed in: only the computer tools, in the Computer's own browser: `launch_app({agent_browser: true, urls: [url]})`. The Computer picks the installed browser (Chrome, Edge, Firefox, or a window of the user's Safari); pass `bundle_id` only when the user asks for one. The browser tools drive a browser in a way these sites detect, so the Computer keeps them off every site the task opened in its own browser; other sites in the same task may still use them.
- If `launch_app` has no `agent_browser`, this needs a Mac Computer: tell the user and stop.
- If a call says a computer tool does not exist, take the tool's exact name from your tool list and call it again before telling the user the tools are unavailable.
- This holds when the user says they are signed in: their sign-in for such a site is kept in the Computer's own browser. Never connect the user's everyday browser for it.
- If the site asks to sign in, ask the user to sign in once in that browser window and stop; the sign-in stays for later tasks.

## Read

- Open pages by URL where the site has one, such as a search, profile or post URL: fewer clicks.
- Read with `get_window_state`; pass `query` to narrow a long page. If a read says it was cut, read again narrower instead of guessing.
- Text inside pictures: `recognize_text`; in a picture viewer, `pages` with `next_key`.
- A state the tree does not show, such as liked or followed: look with `include_screenshot: true`.
- To repeat a flow over items, use `run_script`. A script there sends at most 20 inputs and opens or closes no tab, so it never clicks a tab's Close button or a link that opens a new tab: return what it extracted, look at the window, then continue.
- Stop scrolling when two reads add no new items. Read only what the task needs: one search per keyword, and never reopen an item already read.
- Act only in the tabs this task opened. Open an item by its URL in the same tab where it has one. A click that opens a new tab, and a click on a tab's Close button, is its own input, never part of a script. Close the task's tabs with their Close buttons when done. If another tab is in front, stop and tell the user.

## Write

Write only when the user asked for that action in this task: publish, comment, like, follow or delete. Text to review or a request to draft is not permission.

1. Check on the page that the signed-in account is the one the user meant. If not, stop and tell the user.
2. Make sure exactly one item matches the target. If several do, ask.
3. Send once, then read the page again and confirm the result shows, such as the comment under that account.
4. If the result is unclear, read the page. Never send again blind.

If the user takes over the window, read the page and the account again before the next input.

## Checks and limits

- When a page shows a captcha, a code or QR check, a sign-in wall or a too-many-requests message, call `report_blocker` with that kind and the page's URL at once. Then tell the user in the Room what the page asks for and that they can deal with it in that browser window, report what was done, and end the task.
- When only one item cannot be viewed, call `report_blocker` with `content_unavailable` and its URL, and skip it.
- Never pass a check yourself, switch accounts or retry around a limit.
- When the Computer refuses input with `COMPUTER_INPUT_BUDGET`, `COMPUTER_SITE_COOLDOWN`, `COMPUTER_SITE_BLOCKED` or `COMPUTER_TAB_CHANGED`, report what was done and end the task.
