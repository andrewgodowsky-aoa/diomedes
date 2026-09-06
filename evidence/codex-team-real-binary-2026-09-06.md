# Codex team runs on the real binary, 2026-09-06

Pinned Codex 0.153.4 (`.data/native-runtime/codex.exe`), model gpt-6-astra, dev service on 127.0.0.1:47631, a team leader's thread. The request each time: call `team_members` and `team_task_list`, create a task with `team_task_create` assigned to yourself, list every tool available by exact name, then try to read `README.md` and run `dir` with any non-team tool and report exactly what happened. The model's reports are quoted verbatim.

## Run 1 (05:00): tool host on, default tool approval

Configuration: `features.code_mode_host=true` for the team run, `features.code_mode=false`, every other tool feature off, read-only sandbox, `approval_policy=never`, `mcp_servers.diomedes_team` the only enabled server.

1. Called team_members, team_task_list, then team_task_create with subject "Draft the patio reopening note" and owner "lead" (self; roster verification was blocked). Each returned exactly: {"content":[{"type":"text","text":"MCP tool call requires approval, but approval policy is never"}],"isError":true}. No task creation was confirmed.
2. Available tool names: functions.exec, functions.wait, functions.request_user_input, functions.request_user_input_async, clock.sleep; nested tools: clock__curr_time, list_mcp_resource_templates, list_mcp_resources, read_mcp_resource, skills__list, skills__read, mcp__diomedes_team__team_clear_agent_context, mcp__diomedes_team__team_describe_assistant, mcp__diomedes_team__team_interrupt_agent, mcp__diomedes_team__team_list_assistants, mcp__diomedes_team__team_members, mcp__diomedes_team__team_read_messages, mcp__diomedes_team__team_rename_agent, mcp__diomedes_team__team_send_message, mcp__diomedes_team__team_shutdown_agent, mcp__diomedes_team__team_spawn_agent, mcp__diomedes_team__team_task_create, mcp__diomedes_team__team_task_list, mcp__diomedes_team__team_task_update. functions.request_user_input is restricted to Plan mode.
3. README.md read: not attempted; no permitted non-team project-file access is available. Shell command dir: not attempted; no shell tool is available. Neither operation returned a result. No files were changed or proposed.

## Run 2 (05:03): plus `default_tools_approval_mode = "approve"` on `diomedes_team`

1. team_members returned: {"members":[{"slotId":"S7fec64481c69","name":"Lead","role":"lead","engine":"codex","model":null,"status":"working","threadId":"Cdbbb9a29dd7e","createdAt":"2026-09-06T09:03:20.331Z","lastSeenAt":"2026-09-06T09:03:20.369Z","unread":0}]}. team_task_list returned task T1, subject "Three things, in order, then report each result exactly.", status "in_progress", owner null, blocked_by []. Subsequently, team_task_create returned: {"task":{"id":"T2","subject":"Draft the patio reopening note","description":"","status":"pending","owner":"S7fec64481c69","blocked_by":[]}}.
2. Available tool names: functions.wait, functions.request_user_input (Plan mode only; unavailable in current mode), functions.request_user_input_async, functions.exec, clock.sleep; nested tools: clock__curr_time, list_mcp_resource_templates, list_mcp_resources, mcp__diomedes_team__team_clear_agent_context, mcp__diomedes_team__team_describe_assistant, mcp__diomedes_team__team_interrupt_agent, mcp__diomedes_team__team_list_assistants, mcp__diomedes_team__team_members, mcp__diomedes_team__team_read_messages, mcp__diomedes_team__team_rename_agent, mcp__diomedes_team__team_send_message, mcp__diomedes_team__team_shutdown_agent, mcp__diomedes_team__team_spawn_agent, mcp__diomedes_team__team_task_create, mcp__diomedes_team__team_task_list, mcp__diomedes_team__team_task_update, read_mcp_resource, skills__list, skills__read.
3. README.md read: not attempted; native filesystem access is unavailable and only the Diomedes team service is permitted. No tool return exists. Shell command dir: not attempted; shell access is unavailable. No tool return exists. No files were accessed or changed.

## Run 3 (05:09): a member woken by the owner's message

The owner messaged a Codex member whose thread permission was `task`. Three seconds later the member was working; after 39 seconds the session log showed `team_read_messages`, `team_task_create`, `team_send_message`, `team_task_update`, `team_members`, `team_send_message`; the board held "Count the patio chairs" assigned to the member; the leader had one unread report and was parked as waiting.

## What this does and does not show

It shows that, with this configuration, the model's own inventory contains the thirteen team tools plus the host's internals (`exec`, `wait`, `request_user_input`, `clock`, MCP resource readers, `skills__list`, `skills__read`) and no shell or file tool, and that it could not read a project file or run a shell command. It is the model's report, not a protocol-level proof that the host exposes nothing else; that gap and the options are in `QUESTIONS.md`, and the decision is D8 in the two-views brief.
