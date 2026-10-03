# Verify Perplexity Computer connectivity

Perplexity desktop login, an Agent API key, and Computer MCP OAuth are three different connections. A desktop credit snapshot does not let SigmaDesk call a model. The council currently uses sandboxed Claude/Codex CLIs or separately configured advisor API keys. The separately installed Perplexity thinking-seat relay is distinct from this council coordinator. Computer is not enabled for council calls until OAuth, capabilities, billing and interruption behavior have been verified.

1. Check the client that supplies your connection. For the existing SigmaDesk thinking-seat relay, run:

   ```sh
   claude mcp get perplexity-computer
   ```

   Confirm the official endpoint and Connected status. If registration or OAuth is missing, use `claude mcp add perplexity-computer --transport http https://www.perplexity.ai/rest/computer/mcp`, then open Claude's `/mcp` menu and authenticate. Registration in one client does not authenticate another.

   To also register it in your normal Codex client:

   ```sh
   codex mcp add perplexity-computer --url https://www.perplexity.ai/rest/computer/mcp
   codex mcp login perplexity-computer
   codex mcp list
   ```

   Complete Perplexity's browser OAuth on the account whose Computer credits you want to use. Do not paste credentials or callback URLs into tickets. `mcp list` confirms registration; it does not prove a successful model call. Restart the Codex conversation if the server's tools are not discovered.

2. Ask Codex: “Use perplexity-computer models.list. Report the account's allowed model IDs, modes and reasoning efforts. Do not start a Computer task.” Retain the returned IDs; do not infer them from labels in the desktop model picker. The server documents light/standard/high/ultra modes. Native Model Council selection through MCP is not documented, so do not invent a council mode.

3. Record Computer credits with a timestamp in Perplexity. Then ask Codex: “Use call_perplexity_computer with one allowed model to answer: Return the word connected. Do not use connected apps, browse, create files, send messages or take external actions.” Use either a `model` or a `mode`, not both. Record the response, thread ID, elapsed time, any usage metadata and credits afterward. Subscription credits and Agent API USD are separate units. The official MCP tool list does not document a live balance endpoint or a hard USD cap.

4. Check continuity with a follow-up on the same thread ID, then one different allowed model on that thread. A timeout can leave the cloud task running. Reconcile that thread instead of creating a duplicate. Verify what actually stops execution and billing; do not assume closing the local client cancels the cloud task. If an approval checkpoint appears, inspect it and deny any unexpected external action.

5. During a harmless task, lock the Mac, leave it awake and connected, then unlock and check the same thread and SigmaDesk's Reliability page. After the initial OAuth, the expected path is headless/cloud execution. Confirm that token refresh and follow-up calls do not require desktop interaction. Sleeping, shutdown, logout and network loss are different conditions from screen lock.

Pass evidence: successful OAuth tool discovery, account model list, successful response with a saved thread ID, observed credit delta, reconciled interruption, and locked-screen continuity. Only then enable a server-owned Computer council adapter with isolated credentials, explicit-model independent threads, checkpoint handling and durable remote IDs. Adding MCP to Codex alone does not connect the council: local council reviewers deliberately disable personal MCP servers. Perplexity thinking seats use a separate explicit relay connection, whose status appears under providers.

Sources: [official Computer MCP documentation](https://docs.perplexity.ai/docs/getting-started/integrations/computer-mcp-server), [Agent API quickstart](https://docs.perplexity.ai/docs/agent-api/quickstart), [Model Council in Computer](https://www.perplexity.ai/en-GB/hub/blog/model-council-comes-to-computer). Codex command syntax was checked against the locally installed CLI.
