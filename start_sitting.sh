#!/bin/bash
# start room 2 sitting: serve (loom) + run (tmux session "room2")
cd ~/room
nohup python3 -m room --db room2.db serve --port 8080 > /tmp/serve2.log 2>&1 &
sleep 1
tmux kill-session -t room2 2>/dev/null
tmux new-session -d -s room2 -x 220 -y 50 'cd ~/room && python3 -m room --db room2.db --nous --only "deepseek/deepseek-v4-pro$" --only "qwen/qwen3.8-max" --only "moonshotai/kimi-k2.6" --only "z-ai/glm-5.3$" --only "x-ai/grok-4.3" --only "mistralai/mistral-large-2512" --only "minimax/minimax-m3" --only "meta-llama/llama-4-maverick" --only "nvidia/nemotron-3.5-lightning" --only "google/gemini-3.1-pro-preview$" --only "openai/gpt-6-astra$" --only "anthropic/claude-fable-5.1" --price-ceiling 3 --allow "gpt-6-astra$=3" --allow "claude-fable-5.1=3" --parallel 8 --budget 49 --round-deadline 420 --human "Chance / Tejas" --human-timeout 600 -v run --rounds 15 --pause 2 2>&1 | tee run_room2_sitting1.log; echo; echo "--- sitting finished ---"; read'
sleep 4
tmux capture-pane -t room2 -p | tail -5
