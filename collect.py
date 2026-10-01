#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
매일 실행되는 취업공고 수집 스크립트.
사람인 / 잡코리아 / 원티드 / 캐치에서 프로필에 맞는 공고를 모아
jobs.json 으로 저장한다 (웹페이지가 이 파일을 읽어서 보여줌).
마감된 공고는 제외하고, 마감일이 가까운 공고는 dday를 같이 기록한다.
"""
import json
import re
import time
import hashlib
import urllib.parse
from datetime import datetime, date, timezone, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

BASE_DIR = Path(__file__).parent
JOBS_FILE = BASE_DIR / "jobs.json"
PREV_IDS_FILE = BASE_DIR / "data" / "seen_ids.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
HEADERS = {"User-Agent": UA}

# ---- 사용자 프로필 ----
QUERIES = ["전기전자", "회로설계", "생산관리", "품질관리", "생산기술", "설비관리"]
REGION_KEYWORDS = ["서울", "경기"]
EXCLUDE_EMPLOYMENT = ["계약직", "인턴", "파견", "도급", "아웃소싱", "프리랜서", "일용직", "아르바이트", "단기"]
KST = timezone(timedelta(hours=9))
TODAY = datetime.now(KST).date()


def job_id(*parts):
    return hashlib.md5("|".join(parts).encode("utf-8")).hexdigest()[:16]


def contains_region(text):
    return any(r in text for r in REGION_KEYWORDS)


def is_excluded_employment(text):
    return any(e in text for e in EXCLUDE_EMPLOYMENT)


def dday_of(deadline_str):
    """deadline_str: 'YYYY-MM-DD' or None -> dday (int) or None"""
    if not deadline_str:
        return None
    try:
        d = datetime.strptime(deadline_str, "%Y-%m-%d").date()
    except ValueError:
        return None
    return (d - TODAY).days


def parse_saramin_date(text):
    """'~ 10/17(토)' -> 'YYYY-MM-DD', '채용시' -> None"""
    m = re.search(r"(\d{1,2})/(\d{1,2})", text or "")
    if not m:
        return None
    mm, dd = int(m.group(1)), int(m.group(2))
    try:
        d = date(TODAY.year, mm, dd)
    except ValueError:
        return None
    if d < TODAY - timedelta(days=1):
        d = date(TODAY.year + 1, mm, dd)
    return d.isoformat()


def is_expired(deadline_str):
    dd = dday_of(deadline_str)
    return dd is not None and dd < 0


# ---------------- 사람인 ----------------
def fetch_saramin(query):
    results = []
    url = "https://www.saramin.co.kr/zf_user/search/recruit"
    params = {"searchword": query, "recruitPage": 1, "recruitSort": "relation"}
    try:
        r = requests.get(url, params=params, headers=HEADERS, timeout=15)
        r.raise_for_status()
    except Exception as e:
        print(f"  [사람인] 실패: {e}")
        return results

    soup = BeautifulSoup(r.text, "lxml")
    for item in soup.select(".item_recruit"):
        tit = item.select_one(".job_tit a")
        corp = item.select_one(".area_corp .corp_name a")
        cond = item.select_one(".job_condition")
        if not tit or not corp or not cond:
            continue
        title = tit.get("title", tit.get_text(strip=True))
        company = corp.get_text(strip=True)
        cond_text = cond.get_text(" ", strip=True)
        href = tit.get("href", "")
        link = urllib.parse.urljoin("https://www.saramin.co.kr", href)

        if not contains_region(cond_text):
            continue
        if is_excluded_employment(cond_text):
            continue

        date_el = item.select_one(".job_date .date")
        deadline = parse_saramin_date(date_el.get_text(strip=True)) if date_el else None
        if is_expired(deadline):
            continue

        results.append({
            "id": job_id("saramin", link),
            "site": "사람인",
            "title": title,
            "company": company,
            "location": cond_text.split(" ")[0] if cond_text else "",
            "condition": cond_text,
            "link": link,
            "query": query,
            "deadline": deadline,
            "dday": dday_of(deadline),
        })
    return results


# ---------------- 잡코리아 ----------------
def fetch_jobkorea(query):
    results = []
    url = "https://www.jobkorea.co.kr/Search/"
    params = {"stext": query}
    try:
        r = requests.get(url, params=params, headers=HEADERS, timeout=15)
        r.raise_for_status()
    except Exception as e:
        print(f"  [잡코리아] 실패: {e}")
        return results

    soup = BeautifulSoup(r.text, "lxml")
    cards = soup.select("div.w-full.rounded-2xl.p-0.shadow-list.bg-white")
    for card in cards:
        a = card.select_one('a[href*="/Recruit/GI_Read/"]')
        if not a:
            continue
        title = a.get_text(strip=True)
        if not title:
            continue
        href = a.get("href", "")
        link = urllib.parse.urljoin("https://www.jobkorea.co.kr", href)
        full_text = card.get_text(" ", strip=True)

        if not contains_region(full_text):
            continue
        if is_excluded_employment(full_text):
            continue

        company_el = card.select_one("a[href*='/Company/']")
        company = company_el.get_text(strip=True) if company_el else ""

        # 잡코리아 검색 결과 카드에는 마감일이 표시되지 않아 deadline은 항상 미확인(None)
        results.append({
            "id": job_id("jobkorea", link),
            "site": "잡코리아",
            "title": title,
            "company": company,
            "location": "",
            "condition": full_text[:120],
            "link": link,
            "query": query,
            "deadline": None,
            "dday": None,
        })
    return results


# ---------------- 원티드 ----------------
def fetch_wanted(query):
    results = []
    url = "https://www.wanted.co.kr/api/chaos/search/v1/position"
    params = {
        "query": query, "country": "all", "years": -1,
        "sort": "job.recommend_order", "limit": 20, "offset": 0,
    }
    try:
        r = requests.get(url, params=params, headers=HEADERS, timeout=15)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        print(f"  [원티드] 실패: {e}")
        return results

    for item in data.get("data", []):
        if item.get("employment_type") != "regular":
            continue
        wid = item["id"]
        title = item.get("position", "")
        company = item.get("company", {}).get("name", "")
        link = f"https://www.wanted.co.kr/wd/{wid}"

        location_text = ""
        deadline = None
        try:
            d = requests.get(f"https://www.wanted.co.kr/api/chaos/jobs/v4/{wid}/details",
                              headers=HEADERS, timeout=10).json()
            job = d.get("data", {}).get("job", {})
            addr = job.get("address", {})
            location_text = " ".join(filter(None, [addr.get("location"), addr.get("district")]))
            if not location_text:
                location_text = json.dumps(addr, ensure_ascii=False)
            due_time = job.get("due_time")
            if due_time:
                deadline = due_time[:10]
        except Exception:
            pass

        if not contains_region(location_text):
            continue
        if is_expired(deadline):
            continue

        results.append({
            "id": job_id("wanted", link),
            "site": "원티드",
            "title": title,
            "company": company,
            "location": location_text,
            "condition": "정규직",
            "link": link,
            "query": query,
            "deadline": deadline,
            "dday": dday_of(deadline),
        })
        time.sleep(0.15)
    return results


# ---------------- 캐치 ----------------
def fetch_catch(query):
    results = []
    url = "https://www.catch.co.kr/api/v1.0/recruit/information/getRecruitList"
    params = {
        "Keyword": query, "JobCode": "", "Sido": "", "Career": "", "JCode": "",
        "Size": "", "EduLevel": "", "WorkPosition": "", "CompID": "", "GroupCode": "",
        "Sort": 0, "curpage": 1, "pageSize": 30, "onRecruitYN": "Y", "ExceptIDList": "",
    }
    try:
        r = requests.get(url, params=params, headers=HEADERS, timeout=15)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        print(f"  [캐치] 실패: {e}")
        return results

    for item in data.get("recruitData", []):
        gubun = item.get("GubunCode", "")
        work_area = item.get("WorkArea", "") or ""
        if gubun != "정규직":
            continue
        if not contains_region(work_area):
            continue

        deadline = None
        end_dt = item.get("ApplyEndDatetime")
        if end_dt:
            try:
                deadline = datetime.fromisoformat(end_dt.replace("Z", "+00:00")).astimezone(KST).date().isoformat()
            except Exception:
                deadline = None
        if is_expired(deadline):
            continue

        rid = item.get("RecruitID")
        link = f"https://www.catch.co.kr/NCS/RecruitDetail?RecruitID={rid}"
        results.append({
            "id": job_id("catch", str(rid)),
            "site": "캐치",
            "title": item.get("RecruitTitle", ""),
            "company": item.get("CompName", ""),
            "location": work_area,
            "condition": f"{gubun} · {item.get('ExperienceText', '')}",
            "link": link,
            "query": query,
            "deadline": deadline,
            "dday": dday_of(deadline),
        })
    return results


def main():
    all_jobs = {}

    print("사람인 수집 중...")
    for q in QUERIES:
        for j in fetch_saramin(q):
            all_jobs[j["id"]] = j
        time.sleep(0.3)

    print("잡코리아 수집 중...")
    for q in QUERIES:
        for j in fetch_jobkorea(q):
            all_jobs[j["id"]] = j
        time.sleep(0.3)

    print("원티드 수집 중...")
    for q in QUERIES:
        for j in fetch_wanted(q):
            all_jobs[j["id"]] = j
        time.sleep(0.3)

    print("캐치 수집 중...")
    for q in QUERIES:
        for j in fetch_catch(q):
            all_jobs[j["id"]] = j
        time.sleep(0.3)

    seen_ids = set()
    if PREV_IDS_FILE.exists():
        seen_ids = set(json.loads(PREV_IDS_FILE.read_text(encoding="utf-8")))

    jobs_list = list(all_jobs.values())
    for j in jobs_list:
        j["is_new"] = j["id"] not in seen_ids
        j["urgent"] = j["dday"] is not None and 0 <= j["dday"] <= 3

    PREV_IDS_FILE.parent.mkdir(exist_ok=True)
    PREV_IDS_FILE.write_text(
        json.dumps(list(all_jobs.keys()), ensure_ascii=False), encoding="utf-8"
    )

    # 신규 -> 마감임박 -> 나머지 순으로 정렬 (같은 그룹 안에서는 마감일이 빠른 순)
    def sort_key(j):
        return (
            not j["is_new"],
            not j["urgent"],
            j["dday"] if j["dday"] is not None else 9999,
            j["site"],
        )

    now = datetime.now(KST)
    output = {
        "updated_at": now.isoformat(),
        "updated_at_display": now.strftime("%Y-%m-%d %H:%M"),
        "total": len(jobs_list),
        "new_count": sum(1 for j in jobs_list if j["is_new"]),
        "urgent_count": sum(1 for j in jobs_list if j["urgent"]),
        "jobs": sorted(jobs_list, key=sort_key),
    }
    JOBS_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"완료: 총 {len(jobs_list)}건 (신규 {output['new_count']}건, 마감임박 {output['urgent_count']}건)")


if __name__ == "__main__":
    main()
