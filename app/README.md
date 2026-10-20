# LinkedIn Activity Explorer: web page

The page that turns a LinkedIn export into charts. See [../README.md](../README.md) for how to use, build and host it.

```sh
python3 -m http.server 8791 --bind 127.0.0.1   # then open http://127.0.0.1:8791/?zip
```

Your exports and any pre-built `data.json` live in `../data/`, not here. `data.json` contains your full messages and activity; keep it off shared or public hosts.
