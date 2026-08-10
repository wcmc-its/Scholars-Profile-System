import os, pandas as pd
from sqlalchemy import create_engine, text

engine = create_engine(
    f"mysql+pymysql://{os.environ['DB_USERNAME']}:{os.environ['DB_PASSWORD']}@{os.environ['DB_HOST']}/{os.environ['DB_NAME']}"
)

# Full-time faculty, first OR last author, academic articles. Size by year.
q = """
SELECT r.articleYear AS yr,
       COUNT(DISTINCT r.pmid) AS pubs
FROM analysis_summary_author a
JOIN analysis_summary_article r ON r.pmid = a.pmid
JOIN identity i ON i.cwid = a.personIdentifier
WHERE i.fullTimeFaculty = 'yes'
  AND a.authorPosition IN ('first','last')
  AND r.publicationTypeCanonical = 'Academic Article'
GROUP BY r.articleYear
ORDER BY r.articleYear
"""
with engine.connect() as conn:
    df = pd.read_sql(text(q), conn)

df = df[df['yr'].notna()]
print(df.to_string(index=False))
print("\nTOTAL all years:", int(df['pubs'].sum()))
for lo in (2020, 2021, 2022, 2023):
    print(f"since {lo}:", int(df[df['yr'].astype(str) >= str(lo)]['pubs'].sum()))
