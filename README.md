<p align="center"><img src="assets/logo-horizontal.svg" width="360" alt="Linger"></p>

<p align="center"><b>Linger is an open-source personal agent that runs locally on your computer.</b></p>

<p align="center">
  <b>Open-Source</b>&nbsp;&nbsp;·&nbsp;&nbsp;<b>Local AI</b>&nbsp;&nbsp;·&nbsp;&nbsp;<b>Consumer Macs &amp; PCs</b>
</p>

<p align="center">
  <a href="https://docs.simplexai.com/"><img alt="Documentation" src="https://img.shields.io/badge/Docs-0975ce"></a>
  <a href="https://github.com/simplexai-labs/PolyStrata"><img alt="Powered by PolyStrata" src="https://img.shields.io/badge/Powered%20by-PolyStrata-1a1a16?logo=github&logoColor=white"></a>
  <a href="https://github.com/Niko1221/Strata"><img alt="Powered by Strata" src="https://img.shields.io/badge/Powered%20by-Strata-1a1a16?logo=github&logoColor=white"></a>
</p>

<p align="center"><img src="assets/hero.gif" width="900" alt="Linger: Open Source Personal Agent That Fully Runs on Your Local PC. Finds what you need across apps, remembers what matters, and gets things done. Open-Source, Local AI, Consumer Macs and PCs. Five pages play in turn. Local AI, powered by PolyStrata: a 125B parameter model on a 12 GB GPU, with the 55 GB 3-bit model file kept partly in GPU memory and the rest in RAM or on SSD, writing 45.5 tokens per second with Qwen3.8-Flash-Next on an RTX 3060 12 GB with 64 GB of RAM. Find and connect: stop searching app by app; Linger searches Files, Mail, Calendar, Slack and Docs and returns a project brief with its status, what is blocked and who can help. Remember and grow: a detail from a chat three weeks ago, Mom's birthday is the 14th and she loves orchids, is saved to memory and becomes a birthday plan with an orchid order to approve, right on time. Get it done: Linger keeps working while you are away, sorting the week's files by project, summarizing progress, drafting the recap email and preparing the weekly brief, ready for your review. Agent teams: one launch brief becomes a team.md that a research agent, a copy agent and a visuals agent follow, and they bring back a launch package for review"></p>

Powered by **Efficient AI model–harness co-design**, it brings powerful local AI to everyday computers. It understands your context across files and apps, remembers what matters, and proactively gets things done.

**Your data and memories stay private and local.**

## Why local

|                       | Cloud chat assistant   | Linger                                     |
| --------------------- | ---------------------- | ------------------------------------------ |
| Where the model runs  | A remote server        | Your own GPU or Mac, on supported hardware |
| Where memory lives    | The provider's account | On your device, in local mode              |
| What it can reach     | What you paste in      | Files and apps you authorize               |
| What you get back     | An answer              | A finished task, ready for review          |
| Who can read the code | The vendor             | Everyone. It is open source                |

## Cool features

<a href="docs/local-inference.md"><img src="assets/feature-local-moe.webp" width="100%" alt="Run a 125B model on a 12 GB GPU, powered by PolyStrata: Qwen3.8-Flash-Next, whose 3-bit model file is 55 GB. GPU only, the baseline: the whole model has to sit on the card, only 12 GB fits and the rest has nowhere to go, so it needs 55 GB or more of VRAM, an H100 80 GB. With PolyStrata, ours: a router picks experts for each token. The busiest experts stay in the 12 GB of GPU memory, warm experts wait in 64 GB of system RAM and cold experts on the SSD. Tokens use experts on the GPU and in RAM, and an expert picked from the SSD is read into RAM while one RAM expert moves back to the SSD. Result: 45.5 tokens per second on an RTX 3060 12 GB with 64 GB of RAM, and 179 on an RTX 5090 32 GB"></a>

| Feature                              | What it does                                                                                                                                           |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Efficient AI model–harness co-design | Brings a full local agent to supported consumer Macs and PCs.                                                                                          |
| Efficient MoE inference              | PolyStrata optimizes local inference so larger models can run with less GPU memory.                                                                    |
| Privacy and data ownership           | In local mode, personal data and memories stay on your device. Connected apps exchange data with their services.                                       |
| Cross-app context                    | Understands work across authorized files and apps.                                                                                                     |
| Wiki and memory                      | Remembers important information, preferences, and decisions across conversations, in wiki pages every agent can search.                                |
| Proactive Another Me                 | Watches your inbox, calendar and Slack, follows up and moves work forward, and messages you only when something needs you. Every "not now" teaches it. |
| Agent teams                          | Brings in the agents a job needs and writes one `team.md` that they all follow.                                                                        |

## Quick start

### Option 1: the desktop app

For one person on one computer. Download the package for your platform from
[GitHub Releases](https://github.com/simplexai-labs/linger/releases). The app
opens Linger, connects this computer and runs its agents. **Quick Install** on its
setup screen sets up a Linger server on this computer too.

| Platform             | Package                                     |
| -------------------- | ------------------------------------------- |
| macOS, Apple silicon | `Linger-<version>-arm64.dmg`                |
| macOS, Intel         | `Linger-<version>-x64.dmg`                  |
| Windows x64          | `Linger-<version>-x64-setup.exe` and `.zip` |
| Linux x64            | None. Run from source.                      |

### Option 2: Docker Compose

For a server that several computers share, or to build from source. You need
Docker with Compose and at least 5 GiB of memory for its virtual machine.

```bash
git clone https://github.com/simplexai-labs/linger.git
cd linger
cp .env.example .env
docker compose up --build --detach --wait
```

Create the owner account. As written, it signs in as `owner@linger.local` with
the test password `test1234`; replace either one to use your own:

```bash
printf '%s\n' 'test1234' | docker compose exec -T teamhub \
  teamhub-account create-owner --email owner@linger.local --password-stdin
```

Change the test password in **Settings › Security** before other people can
reach the server.

Open <http://localhost:3000> and sign in. The app then shows the commands that
connect your computer. See
[Install with Docker Compose](https://docs.simplexai.com/install/docker-compose)
to serve other computers on your network and to turn on voice.

## Learn more

The full documentation lives at **[docs.simplexai.com](https://docs.simplexai.com/)**.

<table>
  <tr>
    <th width="180" align="left"><img src="assets/learn/set-up.svg" width="18" height="18" alt="">&nbsp;Set up</th>
    <th width="520" align="left">What it covers</th>
  </tr>
  <tr>
    <td><a href="https://docs.simplexai.com/install/desktop-app">Desktop app</a></td>
    <td>Install the app, or build it from source.</td>
  </tr>
  <tr>
    <td><a href="https://docs.simplexai.com/models/choose-a-runtime">Choose a runtime</a></td>
    <td>Claude Code, Codex or Pi, on local models or a subscription.</td>
  </tr>
  <tr>
    <td><a href="docs/self-hosting.md">Self-hosting</a></td>
    <td>Run it with Docker Compose to serve several computers.</td>
  </tr>
  <tr>
    <td><a href="docs/self-hosting.md#troubleshooting">Troubleshooting</a></td>
    <td>Fixes for when something does not start.</td>
  </tr>
</table>

## Contributors

<p>
  <a href="https://github.com/simplexai-labs/linger/graphs/contributors">
    <img alt="Linger contributors" src="https://raw.githubusercontent.com/simplexai-labs/linger/contributors/contributors.svg" />
  </a>
</p>

New here? Read the [contribution guide](CONTRIBUTING.md) and pick a [good first issue](https://github.com/simplexai-labs/linger/issues?q=is%3Aissue%20state%3Aopen%20label%3A%22good%20first%20issue%22).

## Community & Contact

Choose the channel that best fits your question:

- [GitHub Issues](https://github.com/simplexai-labs/linger/issues): report reproducible bugs and track engineering work. Read the [contribution guide](CONTRIBUTING.md) before opening one.
- [Email](mailto:tonyzhang@simplexai.com): write to tonyzhang@simplexai.com for anything that does not fit an issue.
- [Security policy](SECURITY.md): report a vulnerability privately, never in a public issue.

## Acknowledgements

Linger is built on these open-source projects:

- **[PolyStrata](https://github.com/simplexai-labs/PolyStrata):** Runs local models, keeping the experts a model uses most on your GPU.
- **[Strata](https://github.com/Niko1221/Strata):** The inference engine PolyStrata is built on. It runs Qwen3.8-Flash-Next.
- **[BlockNote](https://github.com/TypeCellOS/BlockNote), [Yjs](https://github.com/yjs/yjs) and [Hocuspocus](https://github.com/ueberdosis/hocuspocus):** Power the documents that people and agents edit together.
- **[Hindsight](https://github.com/vectorize-io/hindsight):** Where agent memory's fact extraction and search come from.
- **[Cua](https://github.com/trycua/cua):** Lets agents use the apps on your desktop.
- **[LiveKit](https://github.com/livekit/livekit):** Carries the audio for voice and meetings.
- **[River](https://github.com/riverqueue/river):** Runs TeamHub's background jobs.
- **[NOTICE](NOTICE):** Lists every third-party component, what we adapted from it, and the license that applies.

Thank you to the open-source community for libraries this powerful and this simple: they let us focus on the product itself, and we hope our projects will in turn give everyone an easier-to-use knowledge base.

## Feature Request

Have an idea? [Open a feature request](https://github.com/simplexai-labs/linger/issues/new?template=feature_request.yml) and describe the problem it would solve.

## License

This repository is licensed under the [Linger Open Source License](LICENSE),
based on Apache 2.0 with additional conditions. [NOTICE](NOTICE) lists
third-party code and the logos and images that this license does not cover.

## Star History

<a href="https://www.star-history.com/#simplexai-labs/linger&type=date&legend=top-left">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=simplexai-labs/linger&type=date&theme=dark&legend=top-left" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=simplexai-labs/linger&type=date&legend=top-left" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=simplexai-labs/linger&type=date&legend=top-left" />
  </picture>
</a>
