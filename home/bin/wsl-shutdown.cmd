@echo off
rem Instantly stop the WSL2 VM to free all its RAM/CPU — e.g. before launching a game.
rem Bind a Stream Deck key to this file (System > Open). WSL relaunches on next use;
rem everyday cache give-back is automatic via autoMemoryReclaim in .wslconfig.
wsl.exe --shutdown
