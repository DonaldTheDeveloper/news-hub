# News Hub (public site)

A 3D news globe that gathers free news feeds from ~140 outlets in 40 languages and can translate them.
The site itself is plain static files (Netlify); a free GitHub Action refreshes the news every 30 minutes.
Every story links back to the publisher - only headlines and short summaries are shown.

    site/                  what Netlify serves (HTML, JS, 3D libraries, a sample news.json)
    collector/             Python (standard library only) that builds news.json
    .github/workflows/     the Action that runs the collector and publishes news.json to the `data` branch
    netlify.toml           Netlify settings (publish folder, security + cache headers)

## Setup (about 10 minutes)

1. **GitHub**: create a new *public* repository (public = unlimited free Action minutes), e.g. `news-hub`.
   In this folder run (replace YOU/REPO):

       git remote add origin https://github.com/YOU/REPO.git
       git push -u origin main

2. **Turn on the refresh**: on GitHub open the *Actions* tab, accept "I understand my workflows...", open
   *Refresh news* and press **Run workflow**. After ~1 minute a `data` branch appears containing `news.json`.
3. **Point the site at your data**: edit `site/config.js`, replace `YOU/REPO` with your repository name,
   then `git commit -am "config" && git push`.
4. **Netlify** (netlify.com, sign up; the free plan needs no card): *Add new site -> Import an existing project ->
   GitHub -> pick the repo*. Leave the build command empty. The publish folder (`site`) comes from netlify.toml.
   Then in *Site configuration -> Build & deploy -> Branches and deploy contexts* set **Branch deploys: None**
   and **Deploy previews: Off** - the Action pushes to the `data` branch every 30 minutes and you do not want
   that to count as a deploy.

The site only needs to be redeployed when you change its code - the news updates without any deploy.

## Netlify free-plan budget (300 credits/month, a hard cap)
A production deploy costs 15 credits (~20 a month), bandwidth 20 credits per GB. The page weighs about 0.6 MB
compressed and the news file is served by GitHub, not Netlify - so ~10,000+ visits fit in one month.

## Notes
- Preferences are stored only in each visitor's browser (localStorage). There are no cookies, accounts or analytics.
- Translation runs in the visitor's own browser: Chrome's built-in translator when available, otherwise the free
  MyMemory service (about 5,000 characters/day per visitor).
- Publishers' feeds are provided for personal reading; if you plan a commercial site, check each publisher's terms.
- 3D library: three.js (MIT). Map: Natural Earth (public domain).
