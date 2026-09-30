# Assemble video/clips/*.webm + narration into one MP4.  python3 scripts/build-video.py <out.mp4>
import json, subprocess, sys, os
ORDER = ["home","pool","join","pipeline","profile","raw","date","verdict","cohort","rankings","me","how"]
meta = json.load(open("video/clips/meta.json")); dur = json.load(open("video/durations.json"))
probe = lambda f: float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",f]).decode())
os.makedirs("video/build", exist_ok=True); parts = []
for n in ORDER:
    src = f"video/clips/{n}.webm"; vd = probe(src)
    content = meta[n]["total"] - meta[n]["lead"]
    start = max(0.0, vd - content)                  # recording starts after context creation: trim from the end
    length = vd - start
    out_len = max(length, dur[n] + 0.7)
    freeze = max(0.0, out_len - length)
    out = f"video/build/{n}.mp4"; parts.append(out)
    subprocess.run(["ffmpeg","-v","error","-y","-ss",f"{start:.3f}","-i",src,"-i",f"video/{n}.aiff",
      "-filter_complex", f"[0:v]fps=30,scale=1280:720,setsar=1,tpad=stop_mode=clone:stop_duration={freeze:.3f}[v];[1:a]aresample=48000,apad[a]",
      "-map","[v]","-map","[a]","-t",f"{out_len:.3f}","-c:v","libx264","-preset","medium","-crf","20","-pix_fmt","yuv420p",
      "-c:a","aac","-b:a","160k","-ar","48000","-ac","2",out], check=True)
    print(f"{n:9s} start {start:5.2f}  clip {length:5.2f}  narration {dur[n]:5.2f}  -> {out_len:5.2f}")
open("video/build/list.txt","w").write("".join(f"file '{os.path.abspath(p)}'\n" for p in parts))
subprocess.run(["ffmpeg","-v","error","-y","-f","concat","-safe","0","-i","video/build/list.txt","-c","copy","-movflags","+faststart",sys.argv[1]], check=True)
print("total", round(probe(sys.argv[1]),1), "s ->", sys.argv[1])
