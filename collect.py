#!/usr/bin/env python3
# -*- coding: utf-8 -*-
import json
import time
import hashlib
import urllib.parse
from datetime import datetime, timezone, timedelta
from pathlib import Path

import requests
from bs4 import BeautifulSoup

BASE_DIR = Path(__file__).parent
DATA_DIR = BASE_DIR / "data"
JOBS_FILE = BASE_DIR / "jobs.json"
PREV_IDS_FILE = DATA_DIR / "seen_ids.json"

UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")
HEADERS = {"User-Agent": UA}

QUERIES = ["전기전자", "회로설계", "생산관리", "품질관리", "생산기술", "설비관리"]
REGION_KEYWORDS = ["서울", "경기"]
EXCLUDE_EMPLOYMENT = ["계약직", "인턴", "파견", "도급", "아웃소싱", "프리랜서", "일용직", "아르바이트", "단기"]
KST = timezone(timedelta(hours=9))


def job_id(*parts):
    return hashlib.md5("|".join(parts).encode("utf-8")).hexdigest()[:16]


def contains_region(text):
    return any(r in text for r in REGION_KEYWORDS)


def is_excluded_employment(text):
    return any(e in text for e in EXCLUDE_EMPLOYMENT)


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

        results.append({
            "id": job_id("saramin", link),
            "site": "사람인",
            "title": title,
            "company": company,
            "location": cond_text.split(" ")[0] if cond_text else "",
            "condition": cond_text,
            "link": link,
            "query": query,
        })
    return results


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

        results.append({
            "id": job_id("jobkorea", link),
            "site": "잡코리아",
            "title": title,
            "company": company,
            "location": "",
            "condition": full_text[:120],
            "link": link,
            "query": query,
        })
    return results


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
        try:
            d = requests.get(f"https://www.wanted.co.kr/api/chaos/jobs/v4/{wid}/details",
                              headers=HEADERS, timeout=10).json()
            addr = d.get("data", {}).get("job", {}).get("address", {})
            location_text = " ".join(filter(None, [addr.get("location"), addr.get("district")]))
            if not location_text:
                location_text = json.dumps(addr, ensure_ascii=False)
        except Exception:
            pass

        if not contains_region(location_text):
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
        })
        time.sleep(0.15)
    return results


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
        })
    return results


def fetch_jasoseol():
    results = []
    url = "https://jasoseol.com/employment/calendar_list.json"
    keywords = ["전기", "전자", "제어", "생산", "품질", "설비", "공정", "기계", "안전", "환경"]
    try:
        r = requests.post(url, headers=HEADERS, timeout=15)
        r.raise_for_status()
        data = r.json()
    except Exception as e:
        print(f"  [자소설닷컴] 실패: {e}")
        return results

    for emp in data.get("employment", []):
        title = emp.get("title", "")
        if not any(k in title for k in keywords):
            continue
        company = emp.get("name", "")
        link = f"https://jasoseol.com/employment/{emp.get('id')}"
        results.append({
            "id": job_id("jasoseol", str(emp.get("id"))),
            "site": "자소설닷컴",
            "title": title,
            "company": company,
            "location": "미확인 (직접 확인 필요)",
            "condition": "대기업 공채 일정 - 지역/고용형태 직접 확인 필요",
            "link": link,
            "query": "jasoseol",
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

    print("자소설닷컴 수집 중...")
    for j in fetch_jasoseol():
        all_jobs[j["id"]] = j

    seen_ids = set()
    if PREV_IDS_FILE.exists():
        seen_ids = set(json.loads(PREV_IDS_FILE.read_text(encoding="utf-8")))

    jobs_list = list(all_jobs.values())
    for j in jobs_list:
        j["is_new"] = j["id"] not in seen_ids

    DATA_DIR.mkdir(exist_ok=True)
    PREV_IDS_FILE.write_text(
        json.dumps(list(all_jobs.keys()), ensure_ascii=False), encoding="utf-8"
    )

    now = datetime.now(KST)
    output = {
        "updated_at": now.isoformat(),
        "updated_at_display": now.strftime("%Y-%m-%d %H:%M"),
        "total": len(jobs_list),
        "new_count": sum(1 for j in jobs_list if j["is_new"]),
        "jobs": sorted(jobs_list, key=lambda j: (not j["is_new"], j["site"])),
    }
    JOBS_FILE.write_text(json.dumps(output, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"완료: 총 {len(jobs_list)}건 (신규 {output['new_count']}건)")


if __name__ == "__main__":
    main()
