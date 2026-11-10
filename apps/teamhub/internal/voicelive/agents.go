package voicelive

// ToolCreateAgent creates a General Agent of the user, as the Agent CLI's
// agent create does once its Sponsor approves.
const ToolCreateAgent = "create_agent"

// AgentTool describes the tool that creates an Agent.
var AgentTool = Tool{
	Name: ToolCreateAgent,
	Description: "Create a new Agent for the user: a teammate with its own name and standing instructions, such as “make an Agent that writes my weekly report”. " +
		"name is what the user called it, or a short sensible one when they leave it to you; description is one line on what it does; prompt is its complete working instructions, written from what the user said: its job, what it works on and how it reports, in the user's language. Never invent facts about the user or their work. " +
		"It runs with the same model and on the same computer as you. In a group room it joins this room; in a direct chat it is only created, and create_room can bring it into a new room. " +
		"This is a write: first call without confirmed; it returns needs_confirmation: say its name and what it will do and ask. Only after the user says yes in their next turn, call again with the same arguments and confirmed=true. " +
		"agent_limit: the user already has 50 Agents. agent_unavailable: Agents cannot be created from this call; say so plainly.",
	Parameters: objectSchema([]string{"name", "prompt", "confirmed"}, map[string]any{
		"name":        stringProperty("The Agent's name, at most 120 characters"),
		"description": stringProperty("One line on what it does"),
		"prompt":      stringProperty("Its complete working instructions"),
		"confirmed":   map[string]any{"type": "boolean", "description": "Whether the user said yes to it, in their own next turn"},
	}),
}

// CreateAgentArguments holds the Agent the live model proposes.
type CreateAgentArguments struct {
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Prompt      string    `json:"prompt"`
	Confirmed   LooseBool `json:"confirmed"`
}
