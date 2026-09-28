"""Reads a JSON list of strings on stdin, prints a JSON list of their token counts.

Uses tiktoken's o200k_base (a real, widely used BPE tokenizer). Other model
families tokenize differently (Claude, Qwen, Llama), so absolute counts vary a
few percent by model -- but the *ratio* between full and compressed text, which
is what this benchmark reports, is stable across BPE tokenizers.
"""
import json
import sys

import tiktoken

enc = tiktoken.get_encoding("o200k_base")
texts = json.loads(sys.stdin.buffer.read().decode("utf-8"))
print(json.dumps([len(enc.encode(t, disallowed_special=())) for t in texts]))
