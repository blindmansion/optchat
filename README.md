# OptChat

A chat agent with a bounded context: the full history is kept in SQLite and
compacted in the background into a tree of summaries. The model sees a fixed-size
view of that tree and can use tools to zoom back into the original messages.
Based on [Victor Taelin's OptChat spec](https://gist.github.com/VictorTaelin/91837951a5ce5b38f341ec1ba1df6449),
built on the AI SDK with `bun:sqlite`.

## Running

```sh
bun install
echo "OPENAI_API_KEY=..." > .env
bun chat              # interactive session; /help lists commands
bun chat "message"    # one turn, then exit
```

Run `bun chat` with no terminal attached to see every command and env var.
History is stored in `./chat` (set `OPTCHAT_DIR` to use another directory).

## Testing tool use and compaction

The default view is 128 KB, so it takes a long history before compaction matters
or the model needs to zoom. Use a small view and a separate directory to get
there in a few turns:

```sh
OPTCHAT_VIEW=3000 OPTCHAT_DIR=/tmp/optchat-test bun chat
```

Unit tests: `bun test`.
