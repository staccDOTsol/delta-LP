import json, base64, sys, os
sys.path.insert(0, '/home/claude/abi')
from rpc import call, slot
from solders.pubkey import Pubkey

KLEND=Pubkey.from_string("KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD")
WP=Pubkey.from_string("whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc")
POOL=Pubkey.from_string("Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE")
MARKET="7u3HeHxYDLhnCoErrtycNokbQYbWGzLs6JSDqGAv5PfF"
R_USDC="D6q6wuQSrifJKZYpR1M8R4YawnLDtDsMmWM1NbBmgJ59"; R_SOL="d4A2prbA2whesmvHaL88BH6Ewn5N4bTSU2Ze8P6Bc4Q"
SCOPE="3t4JZcueEzTbVP6kLxXrL3VpWx45jDer4eqysweBchNH"
FARM_USDC="JAvnB9AKtgPsTEoKmn24Bq64UMoYcrtWtq42HHBdsPkh"
WSOL="So11111111111111111111111111111111111111112"; USDC="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

def rd_pk(d,o): return str(Pubkey.from_bytes(d[o:o+32]))
def get_multi(keys):
    out={}
    for i in range(0,len(keys),50):
        chunk=keys[i:i+50]
        res=call("getMultipleAccounts",[chunk,{"encoding":"base64"}])["value"]
        for k,v in zip(chunk,res):
            out[k]=v
    return out

keys=set([MARKET,R_USDC,R_SOL,SCOPE,FARM_USDC,WSOL,USDC,str(POOL)])
lma,_=Pubkey.find_program_address([b"lma",bytes(Pubkey.from_string(MARKET))],KLEND); keys.add(str(lma))
first=get_multi(list(keys))
# reserve vaults
for r in [R_USDC,R_SOL]:
    d=base64.b64decode(first[r]["data"][0])
    for o in [160,192,2560,2600]: keys.add(rd_pk(d,o))
    keys.add(rd_pk(d,64))  # farm_collateral
# farm global config (FarmState: disc + farm_admin@8 + global_config@40)
fd=base64.b64decode(first[FARM_USDC]["data"][0]); keys.add(rd_pk(fd,40))
# whirlpool vaults + tick arrays + oracle
pd=base64.b64decode(first[str(POOL)]["data"][0])
keys.add(rd_pk(pd,133)); keys.add(rd_pk(pd,213))
ts=int.from_bytes(pd[41:43],'little'); tick=int.from_bytes(pd[81:85],'little',signed=True)
span=88*ts; start=(tick//span)*span
ticks=[start+k*span for k in range(-3,4)]
for st in ticks:
    ta,_=Pubkey.find_program_address([b"tick_array",bytes(POOL),str(st).encode()],WP); keys.add(str(ta))
orc,_=Pubkey.find_program_address([b"oracle",bytes(POOL)],WP); keys.add(str(orc))
allacc=get_multi(list(keys))
s=slot(); bt=call("getBlockTime",[s-20])
meta={"slot":s,"unix_timestamp":bt,"pool":str(POOL),"tick_spacing":ts,"tick_current":tick,"tick_arrays":{str(st):str(Pubkey.find_program_address([b"tick_array",bytes(POOL),str(st).encode()],WP)[0]) for st in ticks},"oracle":str(orc),"lma":str(lma)}
n=0
for k,v in allacc.items():
    if v is None:
        print("missing (uninitialized):",k); continue
    json.dump({"pubkey":k,"owner":v["owner"],"lamports":v["lamports"],"executable":v["executable"],"data":v["data"][0]},open(f"accounts/{k}.json","w")); n+=1
json.dump(meta,open("meta.json","w"),indent=1)
print("saved",n,"accounts; slot",s,"ts",bt,"tick",tick,"ts",ts)
