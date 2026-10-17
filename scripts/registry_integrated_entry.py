import sys
from pathlib import Path
import registry_integrated_release as release
if __name__ == '__main__':
    try: release.main(Path(sys.argv[0]).resolve())
    except (Exception,KeyboardInterrupt) as error: raise SystemExit('STOPPED: '+str(error))
