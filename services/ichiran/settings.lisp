(in-package #:ichiran/conn)
(defparameter *connection* (list "jmdict" "postgres" (or (uiop:getenv "ICHIRAN_DB_PASSWORD") "ichiran-local-only") (or (uiop:getenv "ICHIRAN_DB_HOST") "ichiran-db")))
(in-package #:ichiran/dict)
(defparameter *jmdict-data* #p"/root/jmdictdb/jmdictdb/data/")
