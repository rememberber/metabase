(ns metabase.db
  "Application database definition, and setup logic, and helper functions for interacting with it."
  (:require [clojure.tools.logging :as log]
            [metabase.db
             [config :as db.config]
             [connection-pool :as connection-pool]
             [data-migrations :as data-migrations]
             [schema-migrations :as schema-migrations]]
            [metabase.util :as u]
            [metabase.util.i18n :refer [trs]]
            [toucan.db :as db]))

;;; +----------------------------------------------------------------------------------------------------------------+
;;; |                                      CONNECTION POOLS & TRANSACTION STUFF                                      |
;;; +----------------------------------------------------------------------------------------------------------------+

(def ^:private application-db-connection-pool-properties
  "c3p0 connection pool properties for the application DB. See
  https://www.mchange.com/projects/c3p0/#configuration_properties for descriptions of properties."
  {"minPoolSize"     1
   "initialPoolSize" 1
   "maxPoolSize"     15})

(defn connection-pool
  "Create a C3P0 connection pool for the given database `spec`."
  [spec]
  (connection-pool/connection-pool-spec spec application-db-connection-pool-properties))

(defn- create-connection-pool! [spec]
  (db/set-default-quoting-style! (case (db.config/db-type)
                                   :postgres :ansi
                                   :h2       :h2
                                   :mysql    :mysql))
  (db/set-default-db-connection! (connection-pool spec)))


;;; +----------------------------------------------------------------------------------------------------------------+
;;; |                                                    DB SETUP                                                    |
;;; +----------------------------------------------------------------------------------------------------------------+

(def ^:private setup-db-has-been-called?
  (atom false))

(defn db-is-setup?
  "True if the Metabase DB is setup and ready."
  ^Boolean []
  @setup-db-has-been-called?)

(def ^:dynamic *allow-potentailly-unsafe-connections*
  "We want to make *every* database connection made by the drivers safe -- read-only, only connect if DB file exists,
  etc.  At the same time, we'd like to be able to use driver functionality like `can-connect-with-details?` to check
  whether we can connect to the Metabase database, in which case we'd like to allow connections to databases that
  don't exist.

  So we need some way to distinguish the Metabase database from other databases. We could add a key to the details
  map specifying that it's the Metabase DB, but what if some shady user added that key to another database?

  We could check if a database details map matched `db-connection-details` above, but what if a shady user went
  Meta-Metabase and added the Metabase DB to Metabase itself? Then when they used it they'd have potentially unsafe
  access.

  So this is where dynamic variables come to the rescue. We'll make this one `true` when we use `can-connect?` for the
  Metabase DB, in which case we'll allow connection to non-existent H2 (etc.) files, and leave it `false` happily and
  forever after, making all other connnections \"safe\"."
  false)

(defn- verify-db-connection
  "Test connection to database with DETAILS and throw an exception if we have any troubles connecting."
  ([db-details]
   (verify-db-connection (:type db-details) db-details))

  ([driver details]
   {:pre [(keyword? driver) (map? details)]}
   (log/info (u/format-color 'cyan (trs "Verifying {0} Database Connection ..." (name driver))))
   (assert (binding [*allow-potentailly-unsafe-connections* true]
             (require 'metabase.driver.util)
             ((resolve 'metabase.driver.util/can-connect-with-details?) driver details :throw-exceptions))
     (trs "Unable to connect to Metabase {0} DB." (name driver)))
   (log/info (trs "Verify Database Connection ... ") (u/emoji "✅"))))


(def ^:dynamic ^Boolean *disable-data-migrations*
  "Should we skip running data migrations when setting up the DB? (Default is `false`).
  There are certain places where we don't want to do this; for example, none of the migrations should be ran when
  Metabase is launched via `load-from-h2`.  That's because they will end up doing things like creating duplicate
  entries for the \"magic\" groups and permissions entries. "
  false)

(defn migrate!
  "Migrate the database. Direction is a keyword such as `:up` or `:force`. See `metabase.db.schema-migrations/migrate!`
  for more details."
  ([direction]
   (migrate! @db.config/db-connection-details direction))
  ([db-details direction]
   (schema-migrations/migrate! db-details direction)))

(defn- print-migrations-and-quit!
  "If we are not doing auto migrations then print out migration SQL for user to run manually.
   Then throw an exception to short circuit the setup process and make it clear we can't proceed."
  [db-details]
  (let [sql (migrate! db-details :print)]
    (log/info (str "Database Upgrade Required\n\n"
                   "NOTICE: Your database requires updates to work with this version of Metabase.  "
                   "Please execute the following sql commands on your database before proceeding.\n\n"
                   sql
                   "\n\n"
                   "Once your database is updated try running the application again.\n"))
    (throw (Exception. "Database requires manual upgrade."))))

(defn- run-schema-migrations!
  "Run through our DB migration process and make sure DB is fully prepared"
  [auto-migrate? db-details]
  (log/info (trs "Running Database Migrations..."))
  (if auto-migrate?
    ;; There is a weird situation where running the migrations can cause a race condition: if two (or more) instances
    ;; in a horizontal cluster are started at the exact same time, they can all start running migrations (and all
    ;; acquire a lock) at the exact same moment. Since they all acquire a lock at the same time, none of them would
    ;; have been blocked from starting by the lock being in place. (Yes, this not working sort of defeats the whole
    ;; purpose of the lock in the first place, but this *is* Liquibase.)
    ;;
    ;; So what happens is one instance will ultimately end up commiting the transaction first (and succeed), while the
    ;; others will fail due to duplicate tables or the like and have their transactions rolled back.
    ;;
    ;; However, we don't want to have that instance killed because its migrations failed for that reason, so retry a
    ;; second time; this time, it will either run into the lock, or see that there are no migrations to run in the
    ;; first place, and launch normally.
    (u/auto-retry 1
      (migrate! db-details :up))
    ;; if `MB_DB_AUTOMIGRATE` is false, and we have migrations that need to be ran, print and quit. Otherwise continue
    ;; to start normally
    (when (schema-migrations/has-unrun-migrations? (schema-migrations/conn->liquibase))
      (print-migrations-and-quit! db-details)))
  (log/info (trs "Database Migrations Current ... ") (u/emoji "✅")))

(defn- run-data-migrations!
  "Do any custom code-based migrations now that the db structure is up to date."
  []
  (when-not *disable-data-migrations*
    (resolve data-migrations/run-all!)))

(defn setup-db!
  "Do general preparation of database by validating that we can connect.
   Caller can specify if we should run any pending database migrations."
  [& {:keys [db-details auto-migrate]
      :or   {db-details   @db.config/db-connection-details
             auto-migrate true}}]
  (u/with-us-locale
    (verify-db-connection db-details)
    (run-schema-migrations! auto-migrate db-details)
    (create-connection-pool! (db.config/jdbc-details db-details))
    (run-data-migrations!)
    (reset! setup-db-has-been-called? true)))

(defn setup-db-if-needed!
  "Call `setup-db!` if DB is not already setup; otherwise this does nothing."
  [& args]
  (when-not @setup-db-has-been-called?
    (apply setup-db! args)))
