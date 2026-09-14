export function toolResponse(name = "World") {
  return {
    status: "completed",
    output: [
      {
        type: "function_call",
        name: "say_hello",
        call_id: "call_hello_1",
        arguments: JSON.stringify({ name }),
      },
    ],
  };
}

export function textResponse(text = "Hello, World!") {
  return {
    status: "completed",
    output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }],
  };
}
