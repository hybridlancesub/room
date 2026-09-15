#!/bin/bash
# room 2, sitting 2: background run with an inbox seat (no tmux needed)
cd ~/room
rm -f seat.inbox run_room2_sitting2.log
nohup python3 -m room --db room2.db --nous \
  --only 'deepseek/deepseek-v4-pro$' --only 'qwen/qwen3.8-max' --only 'moonshotai/kimi-k2.6' \
  --only 'z-ai/glm-5.3$' --only 'x-ai/grok-4.3' --only 'mistralai/mistral-large-2512' \
  --only 'minimax/minimax-m3' --only 'meta-llama/llama-4-maverick' --only 'nvidia/nemotron-3.5-lightning' \
  --only 'google/gemini-3.1-pro-preview$' --only 'openai/gpt-6-astra$' --only 'anthropic/claude-fable-5.1' \
  --price-ceiling 3 --allow 'gpt-6-astra$=3' --allow 'claude-fable-5.1=3' \
  --parallel 8 --budget 49 --round-deadline 420 \
  --human "Chance / Tejas" --human-timeout 600 --inbox /home/yamkyn/room/seat.inbox \
  run --rounds 15 --pause 2 > run_room2_sitting2.log 2>&1 &
echo "run pid $!"
sleep 12
tail -5 run_room2_sitting2.log
