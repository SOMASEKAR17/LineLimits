import cv2
import numpy as np

# ============================================================
# STEP 1: Load image
# ============================================================
IMAGE_PATH = r"C:\soma\projects\gazoo-gateways\lineLimits\models\test\test.png"   # <-- change this to your image filename

img = cv2.imread(IMAGE_PATH)
if img is None:
    raise FileNotFoundError(f"Could not load image at '{IMAGE_PATH}'. Check the path/filename.")

clone = img.copy()  # keep a clean copy to warp later (so click-markers don't end up in the output)

# ============================================================
# STEP 2: Click 4 points on the image
# Order matters: far-inner -> far-outer -> near-outer -> near-inner
# ============================================================
points = []
labels = ["1: far-inner", "2: far-outer", "3: near-outer", "4: near-inner"]

def click_event(event, x, y, flags, param):
    if event == cv2.EVENT_LBUTTONDOWN and len(points) < 4:
        points.append((x, y))
        print(f"Point {len(points)}: ({x}, {y})")
        cv2.circle(img, (x, y), 6, (0, 0, 255), -1)
        cv2.putText(img, labels[len(points)-1], (x + 10, y),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 255, 255), 2)
        cv2.imshow("Click 4 points, then press any key", img)

print("Click 4 points in this order: far-inner, far-outer, near-outer, near-inner")
print("Then press any key (with the image window focused) to continue.")

cv2.imshow("Click 4 points, then press any key", img)
cv2.setMouseCallback("Click 4 points, then press any key", click_event)
cv2.waitKey(0)
cv2.destroyAllWindows()

if len(points) != 4:
    raise RuntimeError(f"Expected 4 points, got {len(points)}. Re-run and click exactly 4.")

print("Selected points:", points)

# ============================================================
# STEP 3: Perspective transform using the points just clicked
# ============================================================
src_pts = np.float32(points)

output_width, output_height = 400, 900
dst_pts = np.float32([
    [0, 0],
    [output_width, 0],
    [output_width, output_height],
    [0, output_height],
])

M = cv2.getPerspectiveTransform(src_pts, dst_pts)

# Cropped (just the rectangle itself)
birdseye_crop = cv2.warpPerspective(clone, M, (output_width, output_height))
cv2.imwrite("birdseye_crop2.png", birdseye_crop)

# Full-context version (warps the whole frame onto a bigger canvas)
canvas_w, canvas_h = 1400, 1400
offset_x, offset_y = 500, 100
dst_pts_shifted = (dst_pts + np.array([offset_x, offset_y])).astype(np.float32)
M_full = cv2.getPerspectiveTransform(src_pts, dst_pts_shifted)
birdseye_full = cv2.warpPerspective(clone, M_full, (canvas_w, canvas_h))
cv2.imwrite("birdseye_full2.png", birdseye_full)

print("Done. Saved birdseye_crop.png and birdseye_full.png")