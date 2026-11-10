# Node Services

Node Services is one Node process started by role. It hosts the Agent Service (Agent lifecycle, Runtime execution and TeamHub callbacks), Memory, LLM Wiki and the Document Runtime. The Agent Service, Memory and LLM Wiki share one HTTP port (4319 by default) and route by path; the Document Runtime listens on 4321 in its own worker thread. All roles ship in one deployment image.

The Agent Service owns no persisted collaboration state such as Accounts, Rooms or Work Items; TeamHub owns it.

Commands, conventions and boundaries are in [AGENTS.md](./AGENTS.md).
