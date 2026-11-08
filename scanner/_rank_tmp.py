import json
d=json.load(open('frontend/public/watchlist_merged.json'))
out=[]
def sigs(r,tf,src):
    s=[]
    ut=1 if src.get('ut')=='long' else -1 if src.get('ut')=='short' else None
    if ut and src.get('ut_days') is not None and src['ut_days']<=5: s.append((tf+' UT',ut,src['ut_days']))
    hv=src.get('hv') or {}
    if hv.get('s') in (1,-1) and hv.get('n') is not None and hv['n']<=5: s.append((tf+' HV',hv['s'],hv['n']))
    if src.get('tb_days') is not None and src['tb_days']<=5: s.append((tf+' TB',1,src['tb_days']))
    return s
for r in d['rows']:
    a=sigs(r,'D',r)+sigs(r,'W',r.get('W') or {})+sigs(r,'M',r.get('M') or {})
    out.append((r['ticker'],r.get('section'),a))
print("ROWS",len(out),d.get('generated_at'))
for lab,sg in (('GREEN',1),('RED',-1)):
    L=sorted(out,key=lambda o:-sum(1 for x in o[2] if x[1]==sg))[:25]
    print("==",lab)
    for t,sec,a in L:
        m=[x for x in a if x[1]==sg]
        print("RANK",lab,t,len(m),"|".join(f"{n}{'B' if s>0 else 'S'}{k}" for n,s,k in m),"| opp:",len(a)-len(m))
