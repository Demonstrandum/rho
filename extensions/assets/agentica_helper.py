#!/usr/bin/env python3
"""MCP client helper for the Agentica MCP Runtime.

launches the runtime server and executes python code against its `python`
tool. the runtime path and code file come from argv, so the rho agentica
extension can point at any machine's runtime without a hardcoded path.

usage: agentica_helper.py <runtime_path> <code_file>
"""

import asyncio
import sys
from pathlib import Path

try:
    from mcp import ClientSession, StdioServerParameters
    from mcp.client.stdio import stdio_client
except ImportError:
    print("Error: mcp package not found.", file=sys.stderr)
    sys.exit(1)


async def connect_and_execute(runtime_path: Path, code: str) -> str:
    server_params = StdioServerParameters(
        command="nix",
        args=[
            "develop", str(runtime_path), "--command",
            "uv", "run", "--project", str(runtime_path),
            "python", "-m", "agentica_mcp_runtime",
        ],
    )
    async with stdio_client(server_params) as (read, write):
        async with ClientSession(read, write) as session:
            await session.initialize()
            result = await session.call_tool("python", arguments={"code": code})
            parts = [c.text for c in result.content if c.type == "text"]
            return "\n".join(parts) if parts else "(no output)"


def main():
    if len(sys.argv) < 3:
        print("usage: agentica_helper.py <runtime_path> <code_file>", file=sys.stderr)
        sys.exit(2)
    runtime_path = Path(sys.argv[1])
    code = Path(sys.argv[2]).read_text()
    try:
        print(asyncio.run(connect_and_execute(runtime_path, code)), end="")
    except Exception as e:
        print(f"ERROR: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
