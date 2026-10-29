<h1 align="center">lgtm-quiz</h1>

<p align="center">
  <b>Did you actually read that code?</b><br>
  A tiny quiz that runs before you commit and makes sure you understand what your AI just wrote.
</p>

---

AI assistants write code faster than anyone can read it, and "LGTM" gets typed on diffs nobody really looked
at. `lgtm-quiz` is a small nudge against that. It looks at the changes on your branch, asks you questions about
the **risky parts**, and gives you feedback right away.

It is a reminder, not a lie detector. Someone determined to skip understanding can paste the questions into another AI.
The point is to make you stop for two minutes and look at the code, and to teach you when you can't answer.

## See it

The changed code on the left, a question about it on the right, and feedback after every answer:

<p align="center">
  <img src="docs/quiz-answer.png" alt="lgtm-quiz showing a code diff and a question with the correct answer highlighted" width="900">
</p>

Press **I don't know** and you get a short lesson tied to that code, then a new question to check you got it:

<p align="center">
  <img src="docs/quiz-idk.png" alt="lgtm-quiz explaining a concept after the user pressed I don't know, followed by a new question" width="700">
</p>

<sub>The code in these screenshots is a made-up example.</sub>

## How it works

```
 your branch ──► risky changes ──► questions about THIS diff ──► quiz in your browser
                                                                    │
                       explanation after every answer  ◄────────────┤
                       "I don't know" → lesson + a new question  ◄──┘
```

- **Questions come from your diff**, not from a generic bank. They use real scenarios from your change
  ("what happens when the login fails twice in a row?").
- **Three levels**, which you can turn on or off:
  1. **Mechanics**: what does this code do here, with this input?
  2. **Decisions**: why was it done this way instead of another?
  3. **Architecture**: what else does this change affect?
- **"I don't know" is allowed.** Press the button and it explains the concept in plain words, tied to your code,
  then asks a fresh question to check you got it.
- **In your language.** English by default; set `--lang` to quiz yourself in Portuguese, Spanish, German and more.
- **Local and private.** The quiz runs on your machine (`127.0.0.1`, one-time token). The answer key stays on
  the server until you answer.

## Install

You need:

- **Node 20 or newer**: check with `node -v`
- **git**
- **[Claude Code](https://claude.com/claude-code)**, installed and logged in. It is the AI that writes the questions.

Then, one command:

```bash
npm install -g github:JoaoBRBR/lgtm-quiz
```

Check that it worked:

```bash
lgtm-quiz --help
```

That's the whole installation. It works in **every git repository** on your machine, so there's nothing to set up
per project.

**Update:** run the install command again.
**Uninstall:** `npm uninstall -g lgtm-quiz`

> Works on Linux and macOS. On Windows the quiz still starts but may not open the browser by itself; copy the
> `http://127.0.0.1:...` link it prints. (Tested so far on Linux with Node 22.)

## Quick start

Work on a branch as usual, then, before you commit or open a PR, from inside the repo:

```bash
lgtm-quiz
```

It compares your current branch with `main`, writes the questions (about 30 seconds), and opens the quiz in your browser.
Answer, read the feedback, and finish to see your score.

The command exits with code `0` if you pass and `1` if you don't, so you can also use it in scripts.

## Options

| Command | What it does |
| --- | --- |
| `lgtm-quiz` | Quiz on your current branch against `main` |
| `lgtm-quiz --base develop` | Compare against another branch |
| `lgtm-quiz --staged` | Only the changes you have staged |
| `lgtm-quiz --levels 1,2,3` | Which question levels to use (default `1,2`) |
| `lgtm-quiz --questions 8` | Maximum number of questions (default `5`) |
| `lgtm-quiz --lang pt-BR` | Language of the questions and the interface (default `en`) |
| `lgtm-quiz --pass 0.8` | Pass line from 0 to 1 (default `0.7`, i.e. 70%) |
| `lgtm-quiz --help` | Show all options |

**Languages.** English is the default. Use `--lang` with a code (`pt-BR`, `es`, `de`) or a name (`"French"`) and the
questions, answers, explanations and the buttons all switch to that language. Code and identifiers stay as they are.
The interface text is translated the first time you use a language and then saved, so later runs start instantly.

If you run it while you're on the base branch itself, it falls back to your staged changes.
Trivial changes (log removals, formatting, version bumps) are skipped, so a small diff can have only one or two questions.

## Settings per repository

Install once, configure per repo. If you work on a frontend and a backend with different needs, put your
preferences in `~/.config/lgtm-quiz/config.json`. Top-level values apply everywhere, and each entry in `repos`
overrides them for one repository (use its full path):

```json
{
  "passRate": 0.7,
  "language": "en",
  "repos": {
    "/home/me/work/frontend": { "base": "develop", "levels": [1, 2, 3] },
    "/home/me/work/backend":  { "base": "main", "questions": 8 }
  }
}
```

Priority, strongest first: **command-line flags**, then the **`repos` entry**, then the **top-level values**, then the built-in defaults.

Available settings: `base`, `levels`, `questions`, `passRate` and `language`.

Nothing is ever written into your repositories. The last generated questions and translated interface texts are
cached in `~/.cache/lgtm-quiz/`.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| `claude: command not found` | Install Claude Code and log in, then try again. |
| The browser doesn't open | Copy the `http://127.0.0.1:...` link from the terminal into your browser. |
| `Branch "main" not found` | Your base branch has another name. Use `--base <name>` or set it in the config. |
| `No changes to ask about` | The branch has no changes against the base. Make a change, or use `--staged`. |
| Questions seem to ignore parts of a big branch | Very large diffs are cut at about 60,000 characters, so only the first files are used. Quiz on smaller pieces with `--staged`. |

## Current limits

This is an early version. Be aware that:

- The AI can write a bad question. Some are too easy, and the right answer is sometimes the longest one. Please open an issue when you see one.
- Only multiple-choice questions exist for now. Written answers and "explain this function in your own words" are planned.
- It doesn't remember what you know yet, so you can be asked about the same basics again.
- It isn't hooked into `git commit`. You run it yourself.

## Roadmap

- [ ] A second check that filters out guessable or ambiguous questions
- [ ] Smarter selection of the riskiest changes on big branches
- [ ] Written and "explain it" questions, and later voice answers
- [ ] A personal profile, so concepts you already know get asked less
- [ ] Optional `git commit` hook, opt-in per repository
- [ ] Other AI backends besides Claude Code (Codex, Gemini, local models)

## Development

```bash
git clone https://github.com/JoaoBRBR/lgtm-quiz.git
cd lgtm-quiz
npm install      # dev dependencies (TypeScript)
npm link         # makes the lgtm-quiz command point at this folder
npm run build    # rebuild after changing src/
```

The compiled `dist/` folder is committed on purpose: it lets `npm install -g github:...` work without a build step,
so run `npm run build` and commit `dist/` together with your source changes.

The design notes are in [`SPEC.md`](SPEC.md).

## Contributing

Ideas, bad questions and bug reports are welcome. Open an issue and include, if you can, the kind of change
you ran it on (never paste private code).

## License

[MIT](LICENSE). Use it however you like.
