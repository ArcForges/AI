export function toolResponse(name = "World") {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              type: "function",
              id: "call_hello_1",
              function: { name: "say_hello", arguments: JSON.stringify({ name }) },
            },
          ],
        },
      },
    ],
  } as const;
}

export function textResponse(text = "Hello, World!") {
  return {
    choices: [
      {
        finish_reason: "stop",
        message: { role: "assistant", content: text, refusal: null, tool_calls: [] },
      },
    ],
  } as const;
}
