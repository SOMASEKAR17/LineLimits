import json
import cv2
import numpy as np
import torch
from pathlib import Path


# ============================================================
# 1. GPU / DEVICE SETUP (RTX 4060)
# ============================================================

if torch.cuda.is_available():

    DEVICE = torch.device("cuda")

    print(f"GPU detected: {torch.cuda.get_device_name(0)}")
    print("Overlay blending will run on the GPU.")

else:

    DEVICE = torch.device("cpu")

    print(
        "\nWARNING: CUDA is not available to PyTorch. "
        "Falling back to CPU.\n"
        "If you have an RTX 4060, install a CUDA build of "
        "torch, e.g.:\n"
        "  pip uninstall torch\n"
        "  pip install torch --index-url "
        "https://download.pytorch.org/whl/cu124\n"
    )


# ============================================================
# 2. DATASET PATHS
# ============================================================

# The script (newewe.py) lives directly inside the
# "tracks.v1i.coco" project folder, alongside "footage",
# "train", and "track_boundaries" (see project layout).
# Anchoring everything to the script's own location means
# this works no matter which machine / user account it runs
# under, without hardcoding a Downloads path.

ROOT_DIR = Path(__file__).resolve().parent

DATASET_DIR = ROOT_DIR / "train"

COCO_JSON_PATH = DATASET_DIR / "_annotations.coco.json"


# ============================================================
# 3. OUTPUT PATHS
# ============================================================

OUTPUT_DIR = ROOT_DIR / "track_boundaries"

MASK_DIR = OUTPUT_DIR / "masks"

VERIFICATION_DIR = OUTPUT_DIR / "verification"

MASK_DIR.mkdir(parents=True, exist_ok=True)
VERIFICATION_DIR.mkdir(parents=True, exist_ok=True)


# ============================================================
# 4. ROBOfLOW IMAGE -> CAMERA MAPPING
# ============================================================

camera_files = {

    "CAM1":
        "WhatsApp-Image-2026-09-11-at-10-22-09-PM_jpeg.rf."
        "91c0e4d0726eed2785b56835d6ff3a37.jpg",

    "CAM2":
        "WhatsApp-Image-2026-09-11-at-10-22-48-PM_jpeg.rf."
        "9e241571e84de82724cd2e307a1af1e3.jpg",

    "CAM3":
        "WhatsApp-Image-2026-09-11-at-10-23-17-PM_jpeg.rf."
        "24d8aaa950e9b2a226fecb018c729ebc.jpg",

    "CAM4":
        "WhatsApp-Image-2026-09-11-at-10-23-49-PM_jpeg.rf."
        "8752d7a644fcfda36daf83fe8612e79b.jpg",

    "CAM5":
        "WhatsApp-Image-2026-09-11-at-10-24-23-PM_jpeg.rf."
        "1af4fbd3669b212f7db957e3c45ea9c9.jpg",

    "CAM6":
        "WhatsApp-Image-2026-09-11-at-10-24-57-PM_jpeg.rf."
        "4749470f374f001f7b8f79cb0d9670e8.jpg",

    "CAM7":
        "WhatsApp-Image-2026-09-11-at-10-25-36-PM_jpeg.rf."
        "d710c67d247b77615dbb54d275522ec1.jpg",

    "CAM8":
        "WhatsApp-Image-2026-09-11-at-10-26-00-PM_jpeg.rf."
        "9cbeb486fcde6f4e88512847d5947cec.jpg"
}


# Reverse lookup:
# filename -> CAM ID
file_to_cam = {
    filename: cam
    for cam, filename in camera_files.items()
}


# ============================================================
# 5. VIDEO PATHS
# ============================================================

# "footage" is a sibling of "train" inside tracks.v1i.coco,
# per your project layout - not a separate Downloads folder.

FOOTAGE_DIR = ROOT_DIR / "footage"

video_files = {

    "CAM1": FOOTAGE_DIR / "CAM-1.mp4",

    "CAM2": FOOTAGE_DIR / "CAM-2.mp4",

    "CAM3": FOOTAGE_DIR / "CAM-3.mp4",

    "CAM4": FOOTAGE_DIR / "CAM-4.mp4",

    "CAM5": FOOTAGE_DIR / "CAM-5.mp4",

    "CAM6": FOOTAGE_DIR / "CAM-6.mp4",

    "CAM7": FOOTAGE_DIR / "CAM-7.mp4",

    "CAM8": FOOTAGE_DIR / "CAM-8.mp4",
}


# ============================================================
# 6. SETTINGS
# ============================================================

# Initially verify only CAM1.
# After confirming the overlay is correct, change this to:
#
# VERIFY_CAMERA = None
#
# to process all 8.
VERIFY_CAMERA = None


# Number of frames for verification.
#
# 300 = roughly first 10 seconds for 30 FPS
# 0   = entire video
VERIFY_FRAMES = 300


# Overlay transparency
OVERLAY_ALPHA = 0.40


# ============================================================
# 7. LOAD COCO
# ============================================================

if not COCO_JSON_PATH.exists():

    raise FileNotFoundError(
        f"\nCOCO JSON not found:\n"
        f"{COCO_JSON_PATH}"
    )


with open(
    COCO_JSON_PATH,
    "r",
    encoding="utf-8"
) as f:

    coco_data = json.load(f)


print(
    f"Loaded COCO dataset."
)

print(
    f"Images: {len(coco_data['images'])}"
)

print(
    f"Annotations: {len(coco_data['annotations'])}"
)


# ============================================================
# 8. FIND "inside" CATEGORY
# ============================================================

inside_category_ids = {

    category["id"]

    for category in coco_data["categories"]

    if category["name"].lower() == "inside"
}


if not inside_category_ids:

    raise ValueError(
        "\nNo category named 'inside' was found "
        "in the COCO JSON."
    )


print(
    f"Inside category IDs: "
    f"{inside_category_ids}"
)


# ============================================================
# 9. IMAGE LOOKUP
# ============================================================

image_id_to_image = {

    image["id"]: image

    for image in coco_data["images"]
}


# ============================================================
# 10. EXTRACT ALL INSIDE POLYGONS
# ============================================================

static_boundaries = {}


for annotation in coco_data["annotations"]:

    image_id = annotation["image_id"]

    image_info = image_id_to_image.get(
        image_id
    )

    if image_info is None:
        continue


    # COCO may contain paths, so only compare basename.
    file_name = Path(
        image_info["file_name"]
    ).name


    # Is this one of our 8 camera images?
    if file_name not in file_to_cam:
        continue


    # Is it the "inside" class?
    if annotation["category_id"] not in inside_category_ids:
        continue


    segmentation = annotation.get(
        "segmentation"
    )

    if not segmentation:
        continue


    cam_id = file_to_cam[file_name]


    # Create camera entry if needed
    if cam_id not in static_boundaries:

        static_boundaries[cam_id] = {

            "file_name": file_name,

            "width": image_info["width"],

            "height": image_info["height"],

            "polygons": []
        }


    # --------------------------------------------------------
    # COCO polygon format:
    #
    # [
    #     [x1, y1, x2, y2, x3, y3, ...],
    #     [x1, y1, x2, y2, ...]
    # ]
    #
    # Keep ALL polygons.
    # --------------------------------------------------------

    if isinstance(segmentation, list):

        for flat_polygon in segmentation:

            if len(flat_polygon) < 6:
                continue


            points = [

                [
                    flat_polygon[i],
                    flat_polygon[i + 1]
                ]

                for i in range(
                    0,
                    len(flat_polygon),
                    2
                )
            ]


            static_boundaries[
                cam_id
            ]["polygons"].append(points)


    else:

        print(
            f"\nWARNING: "
            f"{cam_id} contains a non-polygon "
            f"segmentation."
        )

        print(
            "This script expects polygon annotations."
        )


# ============================================================
# 11. CHECK THAT ALL 8 WERE FOUND
# ============================================================

print("\n" + "=" * 60)
print("EXTRACTED CAMERAS")
print("=" * 60)

for cam in sorted(static_boundaries):

    data = static_boundaries[cam]

    print(
        f"{cam}: "
        f"{len(data['polygons'])} polygon(s), "
        f"{data['width']}x{data['height']}"
    )


missing = set(camera_files) - set(static_boundaries)

if missing:

    print(
        "\nWARNING: These cameras have no "
        f"'inside' polygon: {sorted(missing)}"
    )


# ============================================================
# 12. SAVE POLYGON JSON
# ============================================================

polygon_json_path = (
    OUTPUT_DIR /
    "static_track_boundaries.json"
)


with open(
    polygon_json_path,
    "w",
    encoding="utf-8"
) as f:

    json.dump(
        static_boundaries,
        f,
        indent=4
    )


print(
    f"\nPolygon data saved to:\n"
    f"{polygon_json_path}"
)


# ============================================================
# 13. CREATE MASK FROM POLYGONS
# ============================================================

def create_mask_from_camera_data(
    camera_data
):

    width = camera_data["width"]

    height = camera_data["height"]


    # uint8:
    #
    # 0 = outside
    # 1 = inside
    #
    mask = np.zeros(
        (height, width),
        dtype=np.uint8
    )


    for polygon in camera_data["polygons"]:

        points = np.asarray(
            polygon,
            dtype=np.float32
        )


        points = np.round(
            points
        ).astype(np.int32)


        cv2.fillPoly(
            mask,
            [points],
            1
        )


    return mask


# ============================================================
# 14. VIDEO INFORMATION
# ============================================================

def get_video_info(
    video_path
):

    if not video_path.exists():

        raise FileNotFoundError(
            f"\nVideo not found:\n"
            f"{video_path}"
        )


    cap = cv2.VideoCapture(
        str(video_path)
    )


    if not cap.isOpened():

        raise RuntimeError(
            f"\nCould not open video:\n"
            f"{video_path}"
        )


    width = int(
        cap.get(
            cv2.CAP_PROP_FRAME_WIDTH
        )
    )


    height = int(
        cap.get(
            cv2.CAP_PROP_FRAME_HEIGHT
        )
    )


    fps = cap.get(
        cv2.CAP_PROP_FPS
    )


    frame_count = int(
        cap.get(
            cv2.CAP_PROP_FRAME_COUNT
        )
    )


    cap.release()


    return (
        width,
        height,
        fps,
        frame_count
    )


# ============================================================
# 15. RESIZE MASK TO VIDEO
# ============================================================

def resize_mask_to_video(
    mask,
    video_width,
    video_height
):

    mask_height, mask_width = mask.shape


    mask_aspect = (
        mask_width /
        mask_height
    )


    video_aspect = (
        video_width /
        video_height
    )


    aspect_difference = (
        abs(
            mask_aspect -
            video_aspect
        )
        /
        mask_aspect
    )


    # Do not allow accidental geometric distortion.
    if aspect_difference > 0.01:

        raise ValueError(

            "\nImage/video aspect ratio mismatch.\n\n"

            f"Annotation: "
            f"{mask_width}x{mask_height}\n"

            f"Video: "
            f"{video_width}x{video_height}\n\n"

            "The mask cannot safely be resized directly.\n"
            "You need to account for cropping/letterboxing "
            "or another geometric transformation."
        )


    if (
        mask_width == video_width
        and
        mask_height == video_height
    ):

        return mask


    print(
        f"Resizing mask: "
        f"{mask_width}x{mask_height} -> "
        f"{video_width}x{video_height}"
    )


    return cv2.resize(

        mask,

        (
            video_width,
            video_height
        ),

        interpolation=cv2.INTER_NEAREST
    )


# ============================================================
# 16. SAVE MASKS
# ============================================================

def save_masks(
    camera,
    mask,
    video_path
):

    # --------------------------------------------------------
    # Standard NumPy mask
    #
    # Useful while developing/debugging.
    # --------------------------------------------------------

    npy_path = (
        MASK_DIR /
        f"{camera}_inside.npy"
    )


    np.save(
        npy_path,
        mask
    )


    # --------------------------------------------------------
    # Packed representation
    #
    # 8 binary pixels -> 1 byte
    # --------------------------------------------------------

    packed = np.packbits(
        mask.reshape(-1)
    )


    packed_path = (
        MASK_DIR /
        f"{camera}_inside_packed.npz"
    )


    np.savez_compressed(

        packed_path,

        packed_mask=packed,

        shape=np.asarray(
            mask.shape,
            dtype=np.int32
        ),

        camera=camera,

        video_path=str(
            video_path
        )
    )


    print(
        f"\nMask storage for {camera}:"
    )


    print(
        f"  .npy size: "
        f"{npy_path.stat().st_size / 1024:.2f} KB"
    )


    print(
        f"  packed .npz size: "
        f"{packed_path.stat().st_size / 1024:.2f} KB"
    )


    print(
        f"  saved: {npy_path}"
    )


    print(
        f"  saved: {packed_path}"
    )


    return (
        npy_path,
        packed_path
    )


# ============================================================
# 17. CREATE VISUAL OVERLAY (GPU-ACCELERATED)
# ============================================================

# The overlay blend (frame * (1-alpha) + green * alpha, only
# inside masked pixels) runs on the GPU via PyTorch/CUDA,
# since it is repeated once per frame across up to 8 videos.
# Contour extraction/drawing stays on cv2 (cheap, CPU-only
# operation on the tiny mask outline, not the whole frame).

def build_gpu_overlay_tensors(
    mask,
    device
):
    """
    Precompute per-camera GPU tensors once, reused for
    every frame of that camera's video.
    """

    mask_bool = torch.from_numpy(
        mask.astype(bool)
    ).to(device)

    # (H, W, 1) so it broadcasts against (H, W, 3) frames
    mask_bool_hw1 = mask_bool.unsqueeze(-1)

    height, width = mask.shape

    green = torch.zeros(
        (height, width, 3),
        dtype=torch.float32,
        device=device
    )

    green[:, :, 1] = 255.0

    return mask_bool_hw1, green


def create_overlay(
    frame,
    mask,
    mask_bool_hw1,
    green_gpu,
    device
):

    # ---- GPU blend ----

    frame_gpu = torch.from_numpy(frame).to(
        device,
        non_blocking=True
    ).float()

    blended = (
        frame_gpu * (1.0 - OVERLAY_ALPHA)
        +
        green_gpu * OVERLAY_ALPHA
    )

    result_gpu = torch.where(
        mask_bool_hw1,
        blended,
        frame_gpu
    )

    result = result_gpu.clamp(0, 255).byte().cpu().numpy()

    # ---- CPU boundary draw (cheap) ----

    contours, _ = cv2.findContours(

        mask,

        cv2.RETR_EXTERNAL,

        cv2.CHAIN_APPROX_SIMPLE
    )


    cv2.drawContours(

        result,

        contours,

        -1,

        (0, 255, 255),

        2
    )


    return result


# ============================================================
# 18. CREATE VERIFICATION VIDEO
# ============================================================

def create_verification_video(
    camera,
    video_path,
    mask
):

    (
        width,
        height,
        fps,
        total_frames
    ) = get_video_info(
        video_path
    )


    output_path = (

        VERIFICATION_DIR /
        f"{camera}_verification.mp4"
    )


    cap = cv2.VideoCapture(
        str(video_path)
    )


    fourcc = cv2.VideoWriter_fourcc(
        *"mp4v"
    )


    writer = cv2.VideoWriter(

        str(output_path),

        fourcc,

        fps,

        (
            width,
            height
        )
    )


    if not writer.isOpened():

        raise RuntimeError(
            f"\nCould not create output video:\n"
            f"{output_path}"
        )


    if VERIFY_FRAMES == 0:

        frames_to_process = total_frames

    else:

        frames_to_process = min(
            VERIFY_FRAMES,
            total_frames
        )


    print(
        f"\nCreating verification video "
        f"for {camera}..."
    )

    print(
        f"Frames: {frames_to_process}"
    )


    # Precompute GPU tensors once per camera.
    mask_bool_hw1, green_gpu = build_gpu_overlay_tensors(
        mask,
        DEVICE
    )


    for frame_number in range(
        frames_to_process
    ):

        success, frame = cap.read()


        if not success:

            print(
                "Video ended early."
            )

            break


        overlay = create_overlay(
            frame,
            mask,
            mask_bool_hw1,
            green_gpu,
            DEVICE
        )


        # Camera name
        cv2.putText(

            overlay,

            camera,

            (
                20,
                40
            ),

            cv2.FONT_HERSHEY_SIMPLEX,

            1,

            (255, 255, 255),

            2,

            cv2.LINE_AA
        )


        # Frame number
        cv2.putText(

            overlay,

            f"Frame: {frame_number}",

            (
                20,
                80
            ),

            cv2.FONT_HERSHEY_SIMPLEX,

            0.8,

            (255, 255, 255),

            2,

            cv2.LINE_AA
        )


        writer.write(
            overlay
        )


    cap.release()

    writer.release()


    print(
        f"\nVerification video saved:\n"
        f"{output_path}"
    )


    return output_path


# ============================================================
# 19. PROCESS ONE CAMERA
# ============================================================

def process_camera(
    camera
):

    print(
        "\n\n" + "=" * 60
    )

    print(
        f"PROCESSING {camera}"
    )

    print(
        "=" * 60
    )


    if camera not in static_boundaries:

        raise ValueError(
            f"No segmentation found for {camera}"
        )


    if camera not in video_files:

        raise ValueError(
            f"No video path found for {camera}"
        )


    camera_data = (
        static_boundaries[camera]
    )


    video_path = (
        video_files[camera]
    )


    print(
        f"\nAnnotation:"
        f"\n{camera_data['file_name']}"
    )


    print(
        f"\nAnnotation resolution: "
        f"{camera_data['width']}x"
        f"{camera_data['height']}"
    )


    print(
        f"Number of polygons: "
        f"{len(camera_data['polygons'])}"
    )


    print(
        f"\nVideo:"
        f"\n{video_path}"
    )


    # --------------------------------------------------------
    # Create original mask
    # --------------------------------------------------------

    mask = create_mask_from_camera_data(
        camera_data
    )


    print(
        f"\nInside pixels: "
        f"{np.count_nonzero(mask):,}"
    )


    print(
        f"Inside percentage: "
        f"{100 * mask.mean():.2f}%"
    )


    # --------------------------------------------------------
    # Get video info
    # --------------------------------------------------------

    (
        video_width,
        video_height,
        fps,
        frame_count
    ) = get_video_info(
        video_path
    )


    print(
        f"\nVideo resolution: "
        f"{video_width}x"
        f"{video_height}"
    )


    print(
        f"FPS: {fps:.2f}"
    )


    print(
        f"Frame count: {frame_count}"
    )


    # --------------------------------------------------------
    # Match mask to video resolution
    # --------------------------------------------------------

    mask = resize_mask_to_video(

        mask,

        video_width,

        video_height
    )


    # --------------------------------------------------------
    # Save masks
    # --------------------------------------------------------

    save_masks(

        camera,

        mask,

        video_path
    )


    # --------------------------------------------------------
    # Create verification video
    # --------------------------------------------------------

    verification_video = (
        create_verification_video(

            camera,

            video_path,

            mask
        )
    )


    return (
        mask,
        verification_video
    )


# ============================================================
# 20. MAIN
# ============================================================

def main():

    # --------------------------------------------------------
    # Verify one camera first
    # --------------------------------------------------------

    if VERIFY_CAMERA is not None:

        process_camera(
            VERIFY_CAMERA
        )

        print(
            "\n\n" + "=" * 60
        )

        print(
            "CAMERA VERIFICATION COMPLETE"
        )

        print(
            "=" * 60
        )

        print(
            "\nOpen the generated verification video."
        )

        print(
            "Check that the green region is correctly "
            "aligned with the track throughout the video."
        )

        print(
            "\nAfter CAM1 is confirmed, set:"
        )

        print(
            'VERIFY_CAMERA = None'
        )

        print(
            "and run again to process CAM1-CAM8."
        )

        return


    # --------------------------------------------------------
    # Process all cameras
    # --------------------------------------------------------

    for camera in sorted(
        camera_files.keys()
    ):

        process_camera(
            camera
        )


    print(
        "\n\n" + "=" * 60
    )

    print(
        "ALL CAMERAS COMPLETE"
    )

    print(
        "=" * 60
    )


if __name__ == "__main__":

    main()