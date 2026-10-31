<div align="center">
  <h1>Discord-Bot</h1>
  <p>A discord bot with alot of features.....</p>
</div>

### Leave a star 🌟 on repo (target 400) and i will build v2 with more advanced features 


![image](https://img.youtube.com/vi/yuyZPfslrsw/maxresdefault.jpg) 

# [ALL IN ONΞ™](https://discord.uoaio.xyz)
## [YouTube](https://tinyurl.com/3jvb65tv)
### [Support Server](https://discord.uoaio.xyz)



# How to setup the bot?
- Watch YouTube Video: [click here](https://www.youtube.com/watch?v=yuyZPfslrsw)
---

### 💘 Emotes Servers 

* 1.0: https://discord.gg/RjHTDAQHkR
* 2.0: https://discord.gg/g7T8KUrmyt
* 2.1.0: https://discord.gg/fmhTFzruzP
* 3.0: https://discord.gg/hpwuhE2vVE
* 3.1.0: https://discord.gg/M7DWTrYEWZ

### 💕Credit
- Code By Techpoint Development 
- Modified By @uoaio - .gg/uoaio



## 💰 Get Your Own Discord Bot (Done For You)
<div align="center">

🔥 **I build production-ready Discord bots for clients**  
👉 Click below to hire me instantly 👇  

[![Fiverr Gig](https://img.shields.io/badge/Order%20Now%20on%20Fiverr-1dbf73?style=for-the-badge&logo=fiverr&logoColor=white)](https://www.fiverr.com/s/1q66Ndz)

</div>
## Veiled migration test setup

This repository keeps the existing Discord.js command and event files as the compatibility test workload. The Veiled runtime is opt-in; it should not replace Discord login or register commands globally during migration tests.

1. Copy `.env.example` to `.env` and set the dedicated Discord and Veiled test-bot tokens. Add `MONGO_TOKEN` only for commands that need the sample database.
2. Keep `SYNC_DISCORD_GLOBAL_COMMANDS=false` and `VEILED_RUNTIME_REGISTER_COMMANDS=false` in the test environment unless command registration is being tested deliberately.
3. Run `npm test` for the offline suite. SDK-backed cases are skipped unless the Veiled bot SDK is available through `VEILED_SDK_PATH` or `VEILED_SDK_PACKAGE`.
4. Run `npm run migration:live` only with the dedicated test bots. It prompts for tokens in the terminal and sends a message that it deletes as part of the smoke check.

Never commit `.env`, tokens, or the local `database.json` conversation data.