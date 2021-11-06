from bs4 import BeautifulSoup
import requests
import json
import re
import subprocess
import os

def file_list():
  try:
    files = {}
    found = False
    resp = requests.get('https://sourceforge.net/projects/sfall/files/sfall/')
    soup = BeautifulSoup(resp.content, "lxml")
    for tag in soup.find_all('script'):
      for tc in tag.contents:
        if 'net.sf.files' in tc:
          m = tc.split('net.sf.staging_days')[0].strip()
          m = m.replace('net.sf.files = ', '').rstrip(';')
          jfiles = json.loads(m)
          found = True
          break
      if found:
        break

    for jf in jfiles:
      if 'sfall_' in jf:
        files[jf] = jfiles[jf]['download_url']
    print(files)
    return files
  except:
    return {}

def get_latest():
  try:
    resp = requests.get('https://sourceforge.net/projects/sfall/best_release.json')
    release = resp.json()['release']
    latest = {}
    latest['ver'] = release['filename'].split('_')[-1].rsplit('.',1)[0]
    latest['url'] = release['url']
    file_list()
    return latest
  except:
    return {'ver': 'unknown', 'url': ''}

def get_current(path):
  proc1 = subprocess.Popen(['strings', os.path.join(path, 'ddraw.dll')], stdout=subprocess.PIPE)
  proc2 = subprocess.Popen(['grep', '#SFALL'], stdin=proc1.stdout, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
  proc1.stdout.close() # Allow proc1 to receive a SIGPIPE if proc2 exits.
  out, err = proc2.communicate()
  ver = out.split()[1].decode('utf-8')
  return ver
