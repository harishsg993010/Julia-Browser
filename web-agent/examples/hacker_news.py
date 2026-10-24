"""Ask the agent for something on a live site and print each step."""

from julia_web_agent import WebAgent


def show(step):
    print(f"[{step.n:02d}] {'ok ' if step.ok else 'ERR'} {step.action}")


with WebAgent(max_steps=15, on_step=show) as agent:
    result = agent.run("What is the title of the top story on Hacker News right now, and how many points does it have?",
                       start_url="https://news.ycombinator.com")

print("\nStatus:", result.status)
print("Answer:", result.answer)
print("Cost: $", result.usage["usd"])
