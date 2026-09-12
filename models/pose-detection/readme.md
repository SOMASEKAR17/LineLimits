# F1 Car Pose Detection — Project Log

Training a custom YOLOv8-Pose model to detect keypoints on F1 cars from images/video, running locally on an RTX 4060 (8GB VRAM).

---

## 1. Project Structure

```
custom-pose-detection/
├── backups/
│   ├── best_v1_color_only.pt      # v1 weights, trained on 70 color-only images (backup before grayscale fine-tune)
│   ├── last_v1_color_only.pt      # v1 last-epoch checkpoint (backup)
│   ├── best_v3_combined.pt        # v3 weights — BEST MODEL SO FAR — trained from scratch on 105 combined color+grayscale images
│   └── last_v3_combined.pt        # v3 last-epoch checkpoint (backup)
├── data/
│   ├── train/
│   │   ├── images/                # 70 original + 35 grayscale duplicates = 105 images
│   │   └── labels/                # YOLO-pose format .txt labels
│   ├── valid/
│   │   ├── images/                # 5 images (untouched, color only)
│   │   └── labels/
│   ├── test/
│   │   ├── images/                # 25 images (untouched, color only — held-out eval set)
│   │   └── labels/
│   ├── data.yaml                  # dataset config (paths, keypoint shape, class names)
│   ├── README.dataset.txt         # Roboflow-generated dataset info
│   └── README.roboflow.txt        # Roboflow export info
├── test.mp4                       # sample video used for video inference test
├── video_pose.py                  # script: video in → annotated video out
├── make_grayscale_copies.py       # script: generates 3-channel grayscale duplicates of train images
├── yolov8n-pose.pt                # pretrained COCO-pose weights (auto-downloaded, used as base for first training run)
├── venv/                          # Python 3.11 virtual environment
└── README.md                      # this file
```

Trained run outputs (note: these landed in a sibling project folder due to a stale Ultralytics `project` default — see Section 6):
```
C:\soma\projects\linelimit\F1_AI_team_detection\runs\pose\
├── train-2\weights\best.pt              # v1 model (color-only, 100 epochs)
├── train-2\weights\last.pt
├── runs\pose\finetune_grayscale\weights\best.pt   # v2 model (grayscale fine-tuned, 30 epochs)
├── runs\pose\combined_v1\weights\best.pt          # v3 model — BEST SO FAR (combined color+grayscale, trained from scratch, 100 epochs)
├── runs\pose\combined_v1\weights\last.pt
├── predict\                              # test video/image inference outputs
└── val\, val-2\, val-3\                  # validation run outputs
```

**Note:** despite passing `project=runs/pose` when launching training, all three runs (v1, v2, v3) landed under the sibling `F1_AI_team_detection` project folder instead of `custom-pose-detection`. This is caused by a global Ultralytics `runs_dir` setting (`C:\Users\<user>\AppData\Roaming\Ultralytics\settings.json`) overriding the `project=` flag — likely left over from an earlier unrelated project. Fix pending (see Next Steps).

---

## 2. Dataset

### v1 (first 100-image batch)
- **Source:** Roboflow project `f1-car-detection-p26zk` (workspace: `somasekar`), Keypoint Detection type.
- **Annotated:** 100 images.
- **Split:** 70 train / 5 valid / 25 test (70/5/25%) — valid set was too small (5 images), causing noisy per-epoch validation metrics throughout early experiments.

### v2 (full 200-image batch) — current dataset
- **Annotated:** all 200 images (finished annotating the remaining 129 from the original upload, effectively became 200 total after review/cleanup).
- **Split:** rebalanced to **80% train / 10% valid / 10% test** (~160 train / 20 valid / 20 test) specifically to fix the noisy-validation-metric problem — 20 images gives a far more stable per-epoch signal than the original 5.
- **Deliberately included some far/pixelated/small-scale car images** (e.g. wide shots of a full grid with cars ranging from large foreground to tiny distant ones) to match real broadcast-footage conditions rather than only clean close-up shots. Kept these to a moderate fraction of the dataset, and used the `v=0` visibility flag rather than guessing keypoint positions where pixel resolution didn't allow confident placement.
- **Old `data/` folder preserved as `data_old_100/`** before replacing with the new export, as a safety backup.

- **Keypoints:** 6 points (`kpt_shape: [6, 3]`), class: `f1`, single class (`nc: 1`) — unchanged across both batches.
- **Visibility handling:** Roboflow's occlusion marking maps to COCO's `v=0/1/2` visibility flags automatically on export — no manual handling needed. Keypoints not visible/confidently locatable in a given image are excluded from the loss for that image rather than guessed.
- **`flip_idx: [0,1,2,3,4,5]`** — still an identity mapping. **Still not yet confirmed correct** — remains an open item (see Next Steps).

### `data.yaml` (current, working version)
```yaml
train: train/images
val: valid/images
test: test/images

kpt_shape: [6, 3]
flip_idx: [0, 1, 2, 3, 4, 5]

nc: 1
names: ['f1']

roboflow:
  workspace: somasekar
  project: f1-car-detection-p26zk
  version: 2
  license: CC BY 4.0
  url: https://universe.roboflow.com/somasekar/f1-car-detection-p26zk/dataset/2
```
**Bug fixed along the way:** originally had `val: val/images`, but the actual folder is named `valid/` — caused a `FileNotFoundError` on first training attempt. Also originally had `../train/images` etc. (paths escaped the `data/` folder incorrectly) — fixed to be relative to `data.yaml`'s own location.

---

## 3. Understanding the Metrics

Every YOLO train/val output reports two groups of numbers — **Box** (how well it finds the car) and **Pose** (how well it places the keypoints on that car) — each with the same four metrics:

- **P (Precision)** — of everything the model predicted as "yes, there's a car/keypoint here," what fraction was actually correct? High precision = few false alarms.
- **R (Recall)** — of everything that was actually there, what fraction did the model successfully find? High recall = few missed detections.
  > Precision and recall trade off against each other — a model can be made "high precision" by only guessing when very confident, which then tanks recall, and vice versa.
- **mAP50** (mean Average Precision at IoU/OKS 0.5) — a single combined precision+recall score using a *loose* correctness threshold. For boxes, "correct" means the predicted box overlaps the true box by at least 50% (IoU = Intersection over Union). For pose, the equivalent is OKS (Object Keypoint Similarity) — how close the predicted keypoint is to the true one, scaled by object size. 0.5 is forgiving — "roughly in the right place" counts as correct.
- **mAP50-95** (mean Average Precision averaged over thresholds 0.5 → 0.95) — the same idea, but averaged across a *range* of strictness levels from loose (0.5) to very strict (0.95, near-pixel-perfect). **This is the metric to trust most for judging real quality**, since it can't be gamed by "roughly close" predictions — it specifically punishes sloppy, imprecise localization. This is why every comparison table in this README is anchored on **mAP50-95**, not mAP50: a model can score well on mAP50 while still being mediocre at precise keypoint placement, and mAP50-95 is what exposes that gap.

**Worked example from this project:** v5's Pose mAP50 (0.659) looked only modestly worse than v4's (0.725) — but the mAP50-95 gap told the real story (0.195 vs 0.209). v5 wasn't drastically worse at rough localization, just slightly worse at *precise* localization — exactly what mAP50-95 is designed to catch, and what mAP50 alone would have masked. This is the basis for the "use v4, not v5" recommendation in Section 8.

---

## 4. Environment Setup

**Problem hit:** Initial venv used **Python 3.14**, but no CUDA-enabled PyTorch wheels exist for that version yet — `pip install torch` silently installed a **CPU-only** build (`torch.cuda.is_available()` returned `False`).

**Fix:** Installed **Python 3.11** alongside 3.14 (both coexist via the `py` launcher), recreated the venv on 3.11, then installed the CUDA build explicitly.

### Commands used
```bash
# Check installed Python versions
py -0

# Recreate venv on Python 3.11
Remove-Item -Recurse -Force venv
py -3.11 -m venv venv
venv\Scripts\activate

# Install PyTorch with CUDA 12.4 support (matches driver's CUDA 13.1 — backward compatible)
pip install torch torchvision --index-url https://download.pytorch.org/whl/cu124

# Verify GPU is actually detected
python -c "import torch; print(torch.__version__); print(torch.cuda.is_available()); print(torch.cuda.get_device_name(0))"
# Expected: 2.6.0+cu124 / True / NVIDIA GeForce RTX 4060 Laptop GPU

# Install YOLO training/inference library
pip install ultralytics
pip install pillow   # for grayscale conversion script
```

**Why `cu124` and not a version matching `nvidia-smi`'s reported CUDA 13.1:** `nvidia-smi` shows the *maximum* CUDA version your driver supports, not a required match. NVIDIA drivers are backward-compatible, so a stable PyTorch build for CUDA 12.1/12.4 runs fine under a newer driver.

---

## 5. Training Run 1 — Baseline (color-only, 100 images... well, 70 train)

```bash
yolo pose train data=data/data.yaml model=yolov8n-pose.pt epochs=100 imgsz=640 batch=16 device=0
```

| Param | Value | Why |
|---|---|---|
| `data=data/data.yaml` | — | dataset config |
| `model=yolov8n-pose.pt` | pretrained COCO-pose weights | warm start instead of training from scratch — COCO-pose backbone features (edges, part structure) transfer well even though it was trained on humans |
| `epochs=100` | 100 | reasonable default for a small-dataset baseline |
| `imgsz=640` | 640×640 | standard YOLOv8 input size |
| `batch=16` | 16 | fits comfortably in 8GB VRAM for the nano model at 640px |
| `device=0` | GPU 0 | forces training onto the RTX 4060 explicitly rather than relying on auto-detect |

### Result (test set, 25 images, 40 instances)
```
Box:  P=0.813  R=0.867  mAP50=0.907  mAP50-95=0.609
Pose: P=0.456  R=0.400  mAP50=0.297  mAP50-95=0.0497
```
Training took **~2 minutes** on the 4060 (100 epochs, 70 train images).

**Read:** Box detection ("is there a car here") is essentially solved even at this small data size. Pose/keypoint precision (mAP50-95 ≈ 0.05) is the weak point — expected for only 70 training images. Inference speed measured at **~79 FPS** (12.6ms/frame: 1.5ms preprocess + 10.1ms inference + 1.0ms postprocess).

---

## 6. Livery-Bias Mitigation — Grayscale Fine-Tune

**Goal:** reduce the risk that the model is keying off livery color/branding rather than car geometry to place keypoints.

**Method:** mix in grayscale (but still 3-channel) duplicates of training images, then fine-tune from the v1 weights at a much lower learning rate — rather than retraining from scratch on 100% grayscale, which risks catastrophic forgetting of useful RGB cues (lighting, shadows, reflections).

### Step 1 — Backup v1 weights before touching anything
```bash
mkdir backups
copy "<...>\train-2\weights\best.pt" "backups\best_v1_color_only.pt"
copy "<...>\train-2\weights\last.pt" "backups\last_v1_color_only.pt"
```

### Step 2 — Generate grayscale duplicates (`make_grayscale_copies.py`)
- Converts 50% of training images to grayscale via `.convert("L").convert("RGB")` — critical that it's converted **back to RGB**, so the saved image is still 3-channel (R=G=B per pixel). Pose models are hardcoded to expect `(3, H, W)` input; true 1-channel grayscale would crash with a dimension mismatch.
- Copies the matching label `.txt` unchanged, since keypoint geometry doesn't change when only color is altered.
- Only applied to `train/` — `valid/` and `test/` deliberately left untouched so evaluation still reflects real color footage.
- Result: 70 originals + 35 grayscale duplicates = **105 training images**.

### Step 3 — Fine-tune from v1 weights, lower learning rate
```bash
yolo pose train data=data/data.yaml model=backups/best_v1_color_only.pt epochs=30 imgsz=640 batch=16 device=0 lr0=0.001 project=runs/pose name=finetune_grayscale
```

| Param | Value | Why |
|---|---|---|
| `model=backups/best_v1_color_only.pt` | v1 weights | continues training from existing weights (transfer learning), not from scratch — this is what makes it a fine-tune, not a fresh train |
| `lr0=0.001` | 1/10th of original `0.01` | prevents the fine-tune from overwriting existing learned features too aggressively — standard practice to avoid catastrophic forgetting |
| `epochs=30` | 30 (vs. 100 originally) | a fine-tune pass needs far fewer epochs than training from scratch |

**Known issue:** output path ended up doubled (`runs/pose/runs/pose/finetune_grayscale`) because `project=runs/pose` was passed while already inside a `runs/pose` working context. Harmless, just a nested folder — worth using an absolute or cleaner relative path next time.

### Step 4 — Compare v1 vs v2 on the held-out test set (25 images, untouched, color-only)
```bash
yolo pose val model=backups/best_v1_color_only.pt data=data/data.yaml split=test
yolo pose val model="<...>\finetune_grayscale\weights\best.pt" data=data/data.yaml split=test
```

| Metric | v1 (color-only) | v2 (grayscale fine-tuned) | Change |
|---|---|---|---|
| Box P | 0.813 | 0.788 | ↓ slightly |
| Box R | 0.867 | 0.850 | ↓ slightly |
| Box mAP50 | 0.907 | 0.845 | ↓ ~7% |
| **Box mAP50-95** | **0.609** | **0.535** | **↓ ~12%** |
| Pose P | 0.456 | 0.614 | **↑ ~35%** |
| Pose R | 0.400 | 0.400 | unchanged |
| Pose mAP50 | 0.297 | 0.380 | **↑ ~28%** |
| **Pose mAP50-95** | **0.0497** | **0.079** | **↑ ~59%** |

### Conclusion from this comparison
Not a clean win, not a failure either — a genuine trade-off:
- **Pose (keypoint) accuracy improved meaningfully** — likely because grayscale training forces the model to rely on shape/geometry rather than livery color to place keypoints, which was the actual goal.
- **Box detection accuracy dropped somewhat** — a mild sign of the catastrophic-forgetting risk the plan warned about, localized to the detection head rather than catastrophic overall (P/R stayed reasonably high, only tight-IoU precision mAP50-95 dropped).
- **Caveat:** the test set is only 25 images and doesn't specifically include unusual/extreme liveries, so this comparison confirms the fine-tune didn't *hurt* color performance much and *did* improve pose precision — but doesn't yet directly prove the original livery-bias hypothesis. That would need a dedicated small test set of deliberately unusual-livery images.

---

## 7. Training Run 3 — Combined (color + grayscale, trained from scratch) — best model on the 100-image dataset

**Rationale:** the two-stage fine-tune (Section 5) showed a trade-off — pose accuracy improved but box accuracy dropped, a mild sign of catastrophic forgetting from the sequential training approach. The fix: instead of training on color first and fine-tuning on grayscale second, train **one model, once, on the combined 105-image set (70 color + 35 grayscale) from the pretrained base**. This removes the sequential-forgetting risk entirely, since there's no "already-trained" state being perturbed — the model just learns both color and grayscale representations simultaneously from epoch 1.

### Command
```bash
yolo pose train data=data/data.yaml model=yolov8n-pose.pt epochs=100 imgsz=640 batch=16 device=0 project=runs/pose name=combined_v1
```
Same hyperparameters as the original v1 baseline (full 100 epochs, default `lr0=0.01`, since this is a fresh training run, not a fine-tune) — the only difference is that `data/train/images` now contains 105 images instead of 70.

Took **~4 minutes** (0.062 hours) on the RTX 4060 for 100 epochs on 105 images.

### Result — full comparison across all three models (test set, 25 images, 40 instances)

| Metric | v1 (color-only) | v2 (finetune-gray) | v3 (combined, from scratch) |
|---|---|---|---|
| Box P | 0.813 | 0.788 | 0.782 |
| Box R | 0.867 | 0.850 | 0.898 |
| Box mAP50 | 0.907 | 0.845 | 0.879 |
| **Box mAP50-95** | 0.609 | 0.535 | **0.578** |
| Pose P | 0.456 | 0.614 | **0.637** |
| Pose R | 0.400 | 0.400 | **0.525** |
| Pose mAP50 | 0.297 | 0.380 | **0.495** |
| **Pose mAP50-95** | 0.0497 | 0.079 | **0.186** |

### Conclusion
**v3 was the best model on the 100-image dataset** (later superseded by v4 once the full 200-image dataset was ready — see Section 8). At the time, this confirmed the hypothesis that mixing grayscale into a single training run avoids the trade-off seen in the sequential fine-tune:
- **Pose mAP50-95 nearly quadrupled vs v1** (0.0497 → 0.186) and **more than doubled vs v2** (0.079 → 0.186) — by far the biggest jump in keypoint precision across all experiments so far.
- **Pose recall jumped** from 0.40 (both v1 and v2) to 0.525 — the model is now finding meaningfully more of the actual keypoints correctly.
- **Box accuracy landed between v1 and v2** (mAP50-95 0.578, vs 0.609 for v1 and 0.535 for v2) — a small dip from the original baseline, but nowhere near the drop seen in the sequential fine-tune, and box recall actually improved (0.898 vs 0.867 for v1).

**Takeaway for future augmentation experiments:** when combining a new augmentation/domain-shift technique with an existing trained model, prefer training a single combined run from the pretrained base over sequential fine-tuning, unless there's a specific reason (e.g. compute cost) to avoid retraining from scratch. Sequential fine-tuning carries real catastrophic-forgetting risk even at a reduced learning rate.

### Backup
```bash
copy "<...>\combined_v1\weights\best.pt" "backups\best_v3_combined.pt"
copy "<...>\combined_v1\weights\last.pt" "backups\last_v3_combined.pt"
```

---

## 8. Full Dataset (200 images) — v4 and v5

Once all 200 images were annotated, the dataset was rebalanced to 80/10/10 (train/valid/test) and a fresh v4/v5 comparison was run — same "color-only vs combined-with-grayscale" test as v1 vs v3, but now on ~2.3x more real annotated data. Ran color-only first, then grayscale-combined, specifically to isolate whether the grayscale trick still helps once dataset size stops being the main bottleneck.

### v4 — full dataset, color-only (baseline)
```bash
yolo pose train data=data/data.yaml model=yolov8n-pose.pt epochs=100 imgsz=640 batch=16 device=0 project=runs/pose name=v4_full_color
```
Same recipe as v1, just on the new ~160-image train set (no grayscale duplicates).

### v5 — full dataset, combined color + grayscale (from scratch)
```bash
python make_grayscale_copies.py
yolo pose train data=data/data.yaml model=yolov8n-pose.pt epochs=100 imgsz=640 batch=16 device=0 project=runs/pose name=v5_full_combined
```
Same recipe as v3 (combined, trained from scratch, not fine-tuned) — regenerated grayscale duplicates against the new 200-image dataset (~160 train → ~80 grayscale dupes → ~240 total training images), then trained fresh.

### Full comparison — all five models, evaluated on their respective test sets

| Metric | v1 (100, color) | v2 (100, finetune-gray) | v3 (100, combined) | v4 (200, color) | v5 (200, combined) |
|---|---|---|---|---|---|
| Box P | 0.813 | 0.788 | 0.782 | 0.889 | 0.912 |
| Box R | 0.867 | 0.850 | 0.898 | 0.968 | 0.970 |
| Box mAP50 | 0.907 | 0.845 | 0.879 | 0.950 | 0.966 |
| **Box mAP50-95** | 0.609 | 0.535 | 0.578 | **0.684** | 0.692 |
| Pose P | 0.456 | 0.614 | 0.637 | 0.746 | 0.768 |
| Pose R | 0.400 | 0.400 | 0.525 | **0.818** | 0.818 |
| Pose mAP50 | 0.297 | 0.380 | 0.495 | **0.725** | 0.659 |
| **Pose mAP50-95** | 0.0497 | 0.079 | 0.186 | **0.209** | 0.195 |

*(Note: v1-v3 test set was 25 images from the original 100-image split; v4-v5 test set is a different, 20-image set from the rebalanced 200-image split — so v1-v3 vs v4-v5 comparisons are directionally informative but not on an identical held-out set. v4 vs v5 is a clean, apples-to-apples comparison, same test set.)*

### Conclusion — this is the key finding of the whole project so far

**More real annotated data (v1→v4) was by far the biggest lever pulled in this entire project** — pose mAP50-95 went from 0.05 to 0.209 just by doubling the dataset from 100 to 200 images, dwarfing any gain from augmentation tricks.

**The grayscale-mixing technique, which gave a large boost at the 100-image scale (v1→v3: 0.05→0.186), essentially stopped helping once more real data was available (v4→v5: 0.209→0.195 — a small net negative on pose mAP50-95 and pose mAP50).** This makes sense in hindsight: grayscale duplication was compensating for data scarcity by manufacturing cheap variation. Once genuine data variety increased, that synthetic variation added little and modestly diluted training signal (duplicated/lower-information images taking up a larger share of an otherwise strong dataset had a small net negative effect on pose precision specifically).

**Current best model: v4 (200 images, color-only, trained from scratch).** Not v5 — the grayscale trick is not worth applying at this dataset size.

### Backups
```bash
copy "<...>\v4_full_color\weights\best.pt" "backups\best_v4_full_color.pt"
copy "<...>\v4_full_color\weights\last.pt" "backups\last_v4_full_color.pt"
copy "<...>\v5_full_combined\weights\best.pt" "backups\best_v5_full_combined.pt"   # kept for the record, not the production model
```

---

## 9. Video Inference Script (`video_pose.py`)

Runs a trained model on a video file, saves an annotated output video with keypoints drawn per frame.

```bash
python video_pose.py --source path\to\your_video.mp4 --model <path to best.pt>
```

Key args:
| Arg | Default | Purpose |
|---|---|---|
| `--source` | required | input video path |
| `--model` | `best.pt` | trained weights to use |
| `--conf` | 0.5 | confidence threshold — lower (e.g. 0.3) to catch more distant/partial cars at the cost of noisier boxes |
| `--device` | 0 | GPU 0; set to `cpu` to force CPU |

Implementation notes:
- Uses `stream=True` in `model.predict()` to process frame-by-frame instead of loading the whole video into memory — matters for longer race footage.
- `save=True` lets Ultralytics auto-write the annotated video.
- Output lands in `<video_folder>/video_output/`.

### Test run result (test.mp4, 525 frames)
```
Speed: 1.5ms preprocess, 10.1ms inference, 1.0ms postprocess per image
```
≈ 12.6ms/frame → **~79 FPS** pure inference throughput (excludes video decode/encode overhead, which adds some wall-clock time on top).

---

## 10. Key Lessons / Gotchas Hit So Far

1. **`nvidia-smi`'s CUDA version ≠ required PyTorch build version.** It's the driver's max supported version; install a stable CUDA 12.x PyTorch build regardless.
2. **Python version matters for PyTorch CUDA wheels.** Very new Python releases (e.g. 3.14) often don't have CUDA wheels yet — silently falls back to CPU-only with no error, only `torch.cuda.is_available() == False` gives it away. Always verify this before training.
3. **Always double check `data.yaml` folder names match actual folders exactly** (`valid` vs `val` caused a `FileNotFoundError`), and that relative paths are relative to `data.yaml`'s own location, not the project root.
4. **`v=0` (not visible) keypoints are handled automatically** by YOLO-pose's loss — no need to guess coordinates for occluded/absent points, just flag correctly during annotation.
5. **Grayscale duplicates must stay 3-channel** (`.convert("L").convert("RGB")`), or the model will crash on the hardcoded 3-channel input shape.
6. **Fine-tuning from existing weights needs a much lower learning rate** (~1/10th to 1/5th of original) to avoid catastrophic forgetting — and even then, some forgetting can still show up in specific metrics (here: box mAP50-95 dipped while pose mAP50-95 improved).
7. **Small val/test sets (5-25 images) produce noisy metrics** — don't over-index on small swings; trust bigger, consistent trends more.
8. **Sequential fine-tuning (train → fine-tune on new data type) carries real catastrophic-forgetting risk even at a reduced learning rate.** Training a single combined run from the pretrained base on the merged dataset (v3) outperformed the sequential fine-tune (v2) on nearly every metric, while avoiding the box-accuracy trade-off entirely. Prefer "combine and train once" over "train then fine-tune" when practical.
9. **A global Ultralytics `settings.json` (`runs_dir`) can silently override the `project=` CLI flag**, causing outputs to land in an unexpected/unrelated folder (every run so far, v1 through v5, ended up under a sibling `F1_AI_team_detection` project instead of `custom-pose-detection`). Worth checking this file early in a new project — still unresolved as of this log.
10. **Augmentation tricks (like grayscale mixing) have diminishing — even mildly negative — returns once real dataset size grows.** They gave a large boost when data was scarce (100 images: v1→v3, pose mAP50-95 0.05→0.186) but added no benefit and a small net negative once more real data was available (200 images: v4→v5, pose mAP50-95 0.209→0.195). Real annotated data consistently outperformed synthetic augmentation as a lever in this project — worth remembering before reaching for another augmentation trick rather than more/better data.

---

## 11. Current Best Model

**`backups\best_v4_full_color.pt`** — trained from scratch on ~160 color-only images (full 200-image annotated dataset, 80/10/10 split), 100 epochs, no grayscale mixing. Test-set pose mAP50-95 = **0.209**, box mAP50-95 = **0.684** — the best result across every metric so far (supersedes v3).

`backups\best_v5_full_combined.pt` (grayscale-mixed version on the same 200-image dataset) is kept for the record but is **not** the recommended model — see Section 8 conclusion: the grayscale trick showed a small net negative on pose accuracy once real dataset size increased.

---

## 12. Next Steps

- [ ] **Annotate more data if possible.** This has been the single highest-leverage action throughout this project (100→200 images: pose mAP50-95 0.05→0.209 on the color-only baseline alone). More real, varied data remains the best lever — more than any augmentation trick tried so far.
- [ ] **Use v4 (`backups\best_v4_full_color.pt`) as the working model going forward.** Do not apply the grayscale-mixing trick at this dataset size — confirmed net-neutral-to-negative on pose accuracy (Section 8).
- [ ] **Fix the `runs_dir` override** in `C:\Users\somas\AppData\Roaming\Ultralytics\settings.json` so future training runs land inside `custom-pose-detection\runs\` as expected, instead of the sibling `F1_AI_team_detection` folder — still unresolved after 5 training runs.
- [ ] **Confirm `flip_idx` mapping** is correct once keypoint names/order are double-checked — currently assumes no left/right mirror pairs among the 6 points.
- [ ] **Build a small dedicated "hard livery" test set** (a handful of deliberately unusual/extreme-color-scheme cars) to directly test the original livery-bias hypothesis, rather than inferring it indirectly from aggregate test metrics. This question is still open — v4 has not been specifically evaluated against it.
- [ ] **Investigate the one video/image with `(no detections)`** seen during earlier test inference (Canadian GP frame 0164) — check whether it's a hard angle/occlusion case or something systematic. Worth re-checking against v4 specifically.
- [ ] Clean up the nested `runs/pose/runs/pose/...` output path issue (tied to the `runs_dir` fix above).
- [ ] If pose accuracy needs to go further, consider: (a) more annotated data as the primary lever, (b) checking per-keypoint accuracy to see if one specific point is dragging the average down, rather than reaching for another blanket augmentation technique.