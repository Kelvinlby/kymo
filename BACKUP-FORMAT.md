KYMO PROJECT BACKUP — FORMAT VERSION 1
======================================

This file describes, completely, how the data in this backup is stored. It is
written into every backup so the data can be read without Kymo, without its
source code and without any website. Everything here uses only long-standing,
openly documented standards: gzip, tar, UTF-8 text, JSON and CSV.

One backup file holds exactly one project.


1. The container
----------------

The backup is a tar archive (POSIX ustar/pax) compressed with gzip. Typical
file name: `<project>-<YYYYMMDD-HHMMSS>.kymo.tar.gz`.

Unpack it with any archive tool, e.g. `tar -xzf file.kymo.tar.gz`, or Python's
standard `tarfile` module.

All files sit under one top-level directory (its name does not matter):

    <top>/README.txt                                this document
    <top>/manifest.json                             what this backup is + the project
    <top>/experiments/<E>/experiment.json           one experiment, its metric list
    <top>/experiments/<E>/metrics/<M>-<P>.csv       metric points

`<E>`, `<M>` and `<P>` are zero-padded decimal numbers (e.g. `000001`,
`000003`, `0000`) that only make file names unique. They carry no meaning; the
JSON files say which file belongs to which metric. Readers must not rely on the
order of files inside the archive.


2. Text conventions
-------------------

* All text is UTF-8, lines end with LF (`\n`).
* Times written as text (`created_at`, …) are RFC 3339 / ISO 8601 in UTC,
  e.g. `2026-11-24T09:30:00.123Z`. `null` means unknown.
* Point timestamps (`ts`) are Unix time: seconds since 1970-01-01T00:00:00Z,
  as a decimal number that may have a fractional part.


3. manifest.json
----------------

    {
      "format": "kymo-project-backup",       always this string
      "format_version": 1,                    this document describes version 1
      "created_at": "2026-11-24T09:30:00.123Z",
      "generator": "kymo-server 0.1.0",       program that wrote the backup
      "project": {
        "name": "llm-pretrain",
        "description": "free text",
        "created_at": "...",
        "owner": "alice",                     username of the owner at backup time
        "everyone": null,                     null | "viewer" | "editor": access every user had
        "members": [ {"username": "bob", "role": "viewer"} ]   per-user access ("viewer" | "editor")
      },
      "experiment_count": 12,
      "metric_count": 340,                    sum over experiments
      "point_count": 123456789                sum over all metrics
    }

The ownership/sharing fields are informational: user accounts are not part of a
backup, so an import makes the importing user the owner and shares nothing.


4. experiments/<E>/experiment.json
----------------------------------

    {
      "name": "7b-lr3e-4",                    unique within the project
      "status": "finished",                   "running" | "finished" | "failed" | "crashed"
      "config": { ... },                      any JSON object (hyperparameters etc.)
      "tags": [ "baseline" ],                 list of strings
      "notes": "free text",
      "host": "gpu-node-3",                   or null
      "created_at": "...",
      "updated_at": "...",
      "metrics": [
        {
          "key": "train/loss",                the metric's name ("/" groups metrics)
          "points": 1000000,                  number of points in its files
          "files": ["metrics/000001-0000.csv", "metrics/000001-0001.csv"]
        }
      ]
    }

`files` are paths relative to the experiment's directory. A metric's points are
the rows of its files concatenated in the listed order.


5. Metric CSV files
-------------------

Plain CSV (RFC 4180, no quoting is ever needed). The first line is the header,
then one point per line:

    step,value,ts
    0,2.3025850929940455,1795497600.125
    1,2.29871,1795497600.75
    2,NaN,1795497601.5

* `step`  — integer, signed 64-bit. Ascending and unique within a metric.
* `value` — the logged number as a decimal (shortest form that reads back as
  the exact same 64-bit IEEE-754 double), or one of the words `NaN`,
  `Infinity`, `-Infinity`. `NaN` means "not a number / no value".
* `ts`    — when the point was logged, Unix seconds (see section 2).

A file holds at most 500,000 points; longer metrics continue in the next file.
Python's `float()` reads every `value` form above, including the words.


6. Reading a backup with nothing but Python (3.8+, standard library only)
-------------------------------------------------------------------------

    import csv, io, json, posixpath, tarfile

    def read_backup(path):
        with tarfile.open(path, "r:*") as tar:
            files = {m.name: m for m in tar.getmembers() if m.isfile()}
            read = lambda name: tar.extractfile(files[name]).read().decode("utf-8")
            manifest_name = next(n for n in files if posixpath.basename(n) == "manifest.json")
            manifest = json.loads(read(manifest_name))
            experiments = []
            for name in sorted(files):
                if posixpath.basename(name) != "experiment.json":
                    continue
                exp = json.loads(read(name))
                exp_dir = posixpath.dirname(name)
                for metric in exp["metrics"]:
                    points = []      # (step, value, ts)
                    for f in metric["files"]:
                        for row in csv.DictReader(io.StringIO(read(posixpath.join(exp_dir, f)))):
                            points.append((int(row["step"]), float(row["value"]), float(row["ts"])))
                    metric["data"] = points
                experiments.append(exp)
            return manifest, experiments

    manifest, experiments = read_backup("llm-pretrain.kymo.tar.gz")
    print(manifest["project"]["name"], len(experiments), "experiments")


7. Compatibility rules
----------------------

* A reader should ignore JSON fields and files it does not know; later versions
  may add some.
* Any change that would break a version-1 reader increases `format_version`.
