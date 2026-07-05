"""Standalone Slickdeals scraping + velocity package.

This package has no dependency on FastAPI, a database, or a running
server. It is designed to be invoked as a one-shot script (see
scripts/run_scrape.py) on a schedule (GitHub Actions cron), writing its
output to JSON files that a static site reads at request time.
"""
