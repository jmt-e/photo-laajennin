"""Generates the photo-realistic scene backgrounds (backgrounds/*.jpg).

Runs Stable Diffusion locally (Realistic Vision 5.1, CreativeML OpenRAIL-M,
with the sd-vae-ft-mse VAE, MIT). The licence claims no rights in the
images it generates, so they can be published in this repo. Fixed seeds
make the results reproducible.

Dev tool only (CPU works, ~5 min per image on 4 cores):
    pip install torch diffusers transformers accelerate safetensors pillow
    python tools/generate_scenes.py backgrounds [name ...]
"""
import sys
import time
import torch
from diffusers import AutoencoderKL, DPMSolverMultistepScheduler, StableDiffusionPipeline
from PIL import Image, ImageFilter

SIZE = 768  # generated size; saved enlarged to 2048 and softly blurred
NEGATIVE = (
    'people, person, man, woman, child, crowd, spectators, player, athlete, face, body, '
    'text, words, letters, watermark, logo, signature, brand, '
    'cartoon, painting, illustration, drawing, anime, 3d render, cgi, '
    'deformed, distorted, blurry, lowres, low quality, jpeg artifacts, oversaturated'
)
STYLE = 'RAW photo, wide angle, natural light, highly detailed, sharp focus, 8k uhd, dslr, Fujifilm XT3, film grain'
SCENES = {
    'beach': ('empty tropical beach, white sand, turquoise sea, gentle waves, a few palm trees, '
              'blue sky with soft white clouds, sunny day, horizon in the middle', 11),
    'basketball-court': ('empty indoor basketball arena, view from the free throw line toward the basket, '
                         'basketball hoop with glass backboard and orange rim, polished hardwood floor '
                         'with painted key and court lines, empty arena seats, bright arena lighting', 5),
    'soccer-stadium': ('empty football stadium, lush green grass pitch with white lines, empty stands, '
                       'floodlights, blue evening sky, view from the pitch at ground level', 31),
    'scenery': ('beautiful alpine landscape, calm turquoise mountain lake, snowy mountain peaks, '
                'green meadow with wildflowers in front, pine forest, blue sky, summer day', 47),
}


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else 'backgrounds'
    # Names, optionally with another seed to try: beach scenery:99
    names = sys.argv[2:] or list(SCENES)
    torch.set_num_threads(max(1, torch.get_num_threads()))
    vae = AutoencoderKL.from_pretrained('stabilityai/sd-vae-ft-mse')
    pipe = StableDiffusionPipeline.from_pretrained(
        'SG161222/Realistic_Vision_V5.1_noVAE', vae=vae, safety_checker=None, requires_safety_checker=False)
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(
        pipe.scheduler.config, algorithm_type='dpmsolver++', solver_type='midpoint', use_karras_sigmas=True)
    for arg in names:
        name, _, seed_arg = arg.partition(':')
        prompt, seed = SCENES[name]
        seed = int(seed_arg) if seed_arg else seed
        name = f'{name}-{seed}' if seed_arg else name
        t = time.time()
        img = pipe(f'{prompt}, {STYLE}', negative_prompt=NEGATIVE, width=SIZE, height=SIZE,
                   num_inference_steps=25, guidance_scale=6.0,
                   generator=torch.Generator().manual_seed(seed)).images[0]
        img.save(f'{out}/{name}-raw.png')
        # Portrait-mode look: enlarge, then soften (the person stays sharp).
        big = img.resize((2048, 2048), Image.LANCZOS).filter(ImageFilter.GaussianBlur(2.5))
        big.save(f'{out}/{name}.jpg', quality=84, optimize=True, progressive=True)
        img.resize((192, 192), Image.LANCZOS).save(f'{out}/{name}-thumb.jpg', quality=80, optimize=True)
        print(f'{name}: {time.time() - t:.0f} s', flush=True)


if __name__ == '__main__':
    main()
