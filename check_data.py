#!/usr/bin/env python3
"""올리기 전 데이터 점검.

이 파일이 있는 폴더 아래의 catalog.json 폴더(KPOP, ACTOR 등)를 모두 검사한다.
1. catalog.json의 Pinterest JPG 대표 사진을 474x로 바꾼다. (--dry-run이면 바꾸지 않음)
2. 모든 json의 문법과 catalog, groups의 양식을 검사한다. groups는 고치지 않는다.
오류가 있으면 종료 코드 1을 돌려준다.

사용: python3 check_data.py [--dry-run]
"""
import argparse
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SKIP_DIRS = {".git", ".github", "@@error"}
CATALOG_KEYS = {"id", "name", "name_kor", "type", "preview1"}
GROUP_KEYS = {"name", "url", "categories", "premium"}
TYPES = {"girl", "boy", "solo", "mixed", "female", "male"}
IMAGE_URL = re.compile(r"^https://i\.pinimg\.com/[^\s\"]+\.(jpe?g|png|webp)(\?[^\s\"]*)?$", re.IGNORECASE)
PINIMG_JPG = re.compile(r"(https://i\.pinimg\.com/)[^/\"\s]+/([^\"\s?#]+\.jpg)", re.IGNORECASE)
HASH = re.compile(r"[0-9a-f]{32}")


def image_key(url):
    name = url.split("?")[0].rsplit("/", 1)[-1]
    match = HASH.search(name)
    return match.group(0) if match else name


def load(path, errors):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        errors.append(f"{path.relative_to(ROOT)}: 읽기 또는 JSON 오류: {exc}")
        return None


def nonempty(value):
    return isinstance(value, str) and value.strip() != ""


def fix_catalog_previews(path, dry_run):
    """줄 형식이 유지되도록 텍스트에서 바꾼다."""
    text = path.read_text(encoding="utf-8")
    json.loads(text)
    count = 0

    def replace(match):
        nonlocal count
        updated = f"{match.group(1)}474x/{match.group(2)}"
        count += updated != match.group(0)
        return updated

    updated = PINIMG_JPG.sub(replace, text)
    json.loads(updated)
    if count and not dry_run:
        path.write_text(updated, encoding="utf-8", newline="\n")
    return count


def check_catalog(path, errors):
    label = path.relative_to(ROOT)
    catalog = load(path, errors)
    if catalog is None:
        return []
    if not isinstance(catalog, list) or not catalog:
        errors.append(f"{label}: 비어 있지 않은 배열이어야 합니다.")
        return []
    ids = []
    for line, entry in enumerate(catalog, start=1):
        where = f"{label} {line}번째"
        if not isinstance(entry, dict) or set(entry) != CATALOG_KEYS:
            errors.append(f"{where}: 키는 {sorted(CATALOG_KEYS)}여야 합니다. {entry}")
            continue
        for key in ("id", "name", "name_kor"):
            if not nonempty(entry[key]):
                errors.append(f"{where}: {key} 값이 비었습니다.")
        if entry["type"] not in TYPES:
            errors.append(f"{where}: 알 수 없는 type '{entry['type']}'")
        if not isinstance(entry["preview1"], str) or not IMAGE_URL.match(entry["preview1"]):
            errors.append(f"{where}: preview1 주소 오류: {entry['preview1']}")
        elif entry["preview1"].lower().split("?")[0].endswith(".jpg") and "/474x/" not in entry["preview1"]:
            errors.append(f"{where}: preview1이 474x가 아닙니다.")
        if nonempty(entry["id"]):
            ids.append(entry["id"])
    for group_id in sorted({i for i in ids if ids.count(i) > 1}):
        errors.append(f"{label}: id 중복: {group_id}")
    return ids


def check_group(path, errors, warnings, seen):
    label = path.relative_to(ROOT)
    rows = load(path, errors)
    if rows is None:
        return 0
    if not isinstance(rows, list) or not rows:
        errors.append(f"{label}: 비어 있지 않은 배열이어야 합니다.")
        return 0
    in_file = {}
    premium = 0
    for line, row in enumerate(rows, start=1):
        where = f"{label} {line}번째"
        if not isinstance(row, dict) or set(row) != GROUP_KEYS:
            errors.append(f"{where}: 키는 {sorted(GROUP_KEYS)}여야 합니다.")
            continue
        for key in ("name", "categories"):
            if not nonempty(row[key]):
                errors.append(f"{where}: {key} 값이 비었습니다.")
        if not isinstance(row["premium"], bool):
            errors.append(f"{where}: premium은 true/false여야 합니다.")
        elif row["premium"]:
            premium += 1
        if not isinstance(row["url"], str) or not IMAGE_URL.match(row["url"]):
            errors.append(f"{where}: url 오류: {row['url']}")
            continue
        key = image_key(row["url"])
        if key in in_file:
            errors.append(f"{where}: 같은 이미지가 {in_file[key]}번째에도 있습니다: {row['url']}")
        else:
            in_file[key] = line
        if key in seen and seen[key] != path.stem:
            warnings.append(f"{label} {line}번째: '{seen[key]}'에도 있는 이미지입니다.")
        seen.setdefault(key, path.stem)
    if premium == len(rows):
        errors.append(f"{label}: 무료 이미지가 없습니다.")
    elif premium == 0:
        warnings.append(f"{label}: 유료 이미지가 없습니다.")
    return len(rows)


def check_folder(folder, dry_run, errors, warnings):
    catalog_path = folder / "catalog.json"
    changed = 0
    try:
        changed = fix_catalog_previews(catalog_path, dry_run)
    except (OSError, ValueError):
        pass  # check_catalog가 같은 파일의 오류를 기록한다.
    if dry_run:
        # 아직 안 바꾼 474x 항목은 --dry-run에서 오류가 아니라 변경 예정으로 보여 준다.
        before = len(errors)
        ids = check_catalog(catalog_path, errors)
        errors[before:] = [e for e in errors[before:] if "474x" not in e]
    else:
        ids = check_catalog(catalog_path, errors)
    groups_dir = folder / "groups"
    files = {p.stem: p for p in groups_dir.glob("*.json")} if groups_dir.is_dir() else {}
    for group_id in ids:
        if group_id not in files:
            errors.append(f"{folder.name}: catalog의 '{group_id}' 그룹 파일이 없습니다.")
    for stem in sorted(set(files) - set(ids)):
        errors.append(f"{folder.name}/groups/{stem}.json: catalog에 없는 파일입니다.")
    seen = {}
    images = sum(check_group(files[stem], errors, warnings, seen) for stem in sorted(files))
    return changed, len(ids), images


def main():
    parser = argparse.ArgumentParser(description="catalog.json을 474x로 바꾸고 데이터 오류를 검사합니다.")
    parser.add_argument("--dry-run", action="store_true", help="파일을 바꾸지 않고 검사만 합니다.")
    args = parser.parse_args()

    errors, warnings = [], []
    folders = sorted(p.parent for p in ROOT.glob("*/catalog.json"))
    if not folders:
        errors.append("catalog.json이 있는 폴더를 찾지 못했습니다.")
    for folder in folders:
        changed, groups, images = check_folder(folder, args.dry_run, errors, warnings)
        action = "변경 예정" if args.dry_run else "변경"
        print(f"{folder.name}: 그룹 {groups}개, 이미지 {images}장, 474x {action} {changed}개")

    # catalog와 groups 외의 json(rankings, 원본 등)은 문법만 본다.
    checked = 0
    for path in sorted(ROOT.rglob("*.json")):
        relative = path.relative_to(ROOT)
        if SKIP_DIRS.intersection(relative.parts):
            continue
        checked += 1
        if path.name != "catalog.json" and "groups" not in relative.parts:
            load(path, errors)
    print(f"JSON 파일 {checked}개 확인")

    if warnings:
        print(f"\n경고 {len(warnings)}건 (올려도 동작에는 문제없음)")
        for line in warnings[:30]:
            print(f"  {line}")
        if len(warnings) > 30:
            print(f"  ...외 {len(warnings) - 30}건")
    if errors:
        print(f"\n❌ 오류 {len(errors)}건")
        for line in errors:
            print(f"  {line}")
        return 1
    print("\n✅ 오류 없음. 올려도 됩니다.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
